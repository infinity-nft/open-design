/**
 * Passphrase-based AES-GCM encryption for BYOK API keys.
 *
 * Threat model. Topology C of OD (web on Vercel + direct API in browser)
 * needs to persist user-supplied API keys without sending them to a
 * server. The legacy implementation stored them as plain JSON in
 * `localStorage`, which OWASP and the W3C Web Crypto recommendation both
 * explicitly call out as unsafe — any XSS exfiltrates the key.
 *
 * This module provides a thin wrapper around SubtleCrypto that:
 *
 *   1. Derives an AES-GCM key from a user passphrase via PBKDF2-SHA-256
 *      with 600 000 iterations (the OWASP 2023 recommendation for SHA-256;
 *      raised to 800 000 for production callers; we stay at the lower
 *      bound to keep first-key login fast in low-power browsers).
 *   2. Generates a random 16-byte salt per blob and a random 12-byte IV
 *      per encryption (nonce reuse with AES-GCM is catastrophic; never
 *      reuse).
 *   3. Stores the result as a self-describing JSON envelope with
 *      version + algorithm fields so future migrations stay readable.
 *
 * What this module does NOT do:
 *
 *   - It does not persist anything. The caller decides whether the
 *     ciphertext lands in localStorage, IndexedDB, or a downloaded file.
 *     Persistence policy is in `secure-config-storage.ts`.
 *   - It does not cache the derived key. The caller can hold a derived
 *     `CryptoKey` in memory if they want to skip PBKDF2 between calls.
 *   - It does not implement key recovery. If the user forgets the
 *     passphrase the data is gone — that is the entire point.
 *
 * SubtleCrypto is available globally in Node 18+ (where `globalThis.crypto`
 * is a Web Crypto implementation) and in every modern browser.
 */

const PBKDF2_ITERATIONS = 600_000;
const SALT_BYTES = 16;
const IV_BYTES = 12; // AES-GCM standard nonce length
const KEY_BYTES = 32; // AES-256
const ALGO_NAME = 'AES-GCM';
const HASH_NAME = 'SHA-256';

export const ENCRYPTED_BLOB_VERSION = 1;

export interface EncryptedBlob {
  v: typeof ENCRYPTED_BLOB_VERSION;
  algo: 'aes-256-gcm/pbkdf2-sha256';
  iter: number;
  /** Base64-encoded salt. */
  salt: string;
  /** Base64-encoded 96-bit IV. */
  iv: string;
  /** Base64-encoded ciphertext (AES-GCM ciphertext + 16-byte tag). */
  ct: string;
}

export function isEncryptedBlob(value: unknown): value is EncryptedBlob {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    v.v === ENCRYPTED_BLOB_VERSION &&
    v.algo === 'aes-256-gcm/pbkdf2-sha256' &&
    typeof v.iter === 'number' &&
    typeof v.salt === 'string' &&
    typeof v.iv === 'string' &&
    typeof v.ct === 'string'
  );
}

function getSubtle(): SubtleCrypto {
  // globalThis.crypto.subtle is available in Node 18+ and every modern
  // browser. The check is a defensive guard for very old test runners
  // and gives a clear error message instead of "undefined.subtle" deep
  // inside a derive call.
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (!c || !c.subtle) {
    throw new Error(
      'Web Crypto unavailable: secure-crypto requires globalThis.crypto.subtle (Node 18+ / modern browser).',
    );
  }
  return c.subtle;
}

function getRandomBytes(n: number): Uint8Array {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (!c) throw new Error('Web Crypto unavailable: getRandomValues missing.');
  return c.getRandomValues(new Uint8Array(n));
}

async function deriveKey(
  passphrase: string,
  salt: Uint8Array,
  iterations: number,
): Promise<CryptoKey> {
  const subtle = getSubtle();
  const enc = new TextEncoder();
  const baseKey = await subtle.importKey(
    'raw',
    enc.encode(passphrase),
    { name: 'PBKDF2' },
    false,
    ['deriveKey'],
  );
  return subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt,
      iterations,
      hash: HASH_NAME,
    },
    baseKey,
    { name: ALGO_NAME, length: KEY_BYTES * 8 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/**
 * Encrypt `plaintext` with a key derived from `passphrase`. Each call
 * uses a fresh random salt and IV; never reuse the resulting blob across
 * different plaintexts manually. AES-GCM nonce reuse with the same key
 * leaks both plaintexts.
 */
export async function seal(
  plaintext: string,
  passphrase: string,
): Promise<EncryptedBlob> {
  if (typeof plaintext !== 'string') {
    throw new TypeError('seal: plaintext must be a string');
  }
  if (typeof passphrase !== 'string' || passphrase.length === 0) {
    throw new TypeError('seal: passphrase must be a non-empty string');
  }
  const subtle = getSubtle();
  const salt = getRandomBytes(SALT_BYTES);
  const iv = getRandomBytes(IV_BYTES);
  const key = await deriveKey(passphrase, salt, PBKDF2_ITERATIONS);
  const enc = new TextEncoder();
  const ctBuffer = await subtle.encrypt(
    { name: ALGO_NAME, iv },
    key,
    enc.encode(plaintext),
  );
  return {
    v: ENCRYPTED_BLOB_VERSION,
    algo: 'aes-256-gcm/pbkdf2-sha256',
    iter: PBKDF2_ITERATIONS,
    salt: bytesToBase64(salt),
    iv: bytesToBase64(iv),
    ct: bytesToBase64(new Uint8Array(ctBuffer)),
  };
}

/**
 * Decrypt an `EncryptedBlob` with `passphrase`. Throws on:
 *   - shape errors (not an EncryptedBlob)
 *   - tag mismatch (wrong passphrase, tampered ciphertext)
 *
 * The thrown error never carries plaintext or key material.
 */
export async function open(
  blob: EncryptedBlob,
  passphrase: string,
): Promise<string> {
  if (!isEncryptedBlob(blob)) {
    throw new TypeError('open: expected an EncryptedBlob');
  }
  if (typeof passphrase !== 'string' || passphrase.length === 0) {
    throw new TypeError('open: passphrase must be a non-empty string');
  }
  const subtle = getSubtle();
  const salt = base64ToBytes(blob.salt);
  const iv = base64ToBytes(blob.iv);
  const ct = base64ToBytes(blob.ct);
  const key = await deriveKey(passphrase, salt, blob.iter);
  let ptBuffer: ArrayBuffer;
  try {
    ptBuffer = await subtle.decrypt({ name: ALGO_NAME, iv }, key, ct);
  } catch {
    // Surface a stable error message; the underlying SubtleCrypto error
    // varies across implementations and can include sensitive context.
    throw new Error('open: decryption failed (wrong passphrase or tampered blob).');
  }
  return new TextDecoder().decode(ptBuffer);
}

// --- base64 helpers (browser + Node) ---------------------------------

function bytesToBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(bytes).toString('base64');
  }
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i += 1) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array {
  if (typeof Buffer !== 'undefined') {
    return new Uint8Array(Buffer.from(b64, 'base64'));
  }
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
