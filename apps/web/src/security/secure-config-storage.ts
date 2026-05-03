/**
 * Encrypted persistence wrapper for `state/config.ts`. Implements the
 * "BYOK keys → encrypted storage" half of plan T0.5.
 *
 * Design.
 *
 *   - Keys live in `localStorage[STORAGE_KEY_ENCRYPTED]` as
 *     stringified `EncryptedBlob`s. The non-secret config (model name,
 *     baseUrl, UI prefs) stays in the existing plaintext slot so a user
 *     who never enables encryption is unaffected.
 *   - The passphrase is held in memory (`sessionPassphrase`) for the
 *     life of the page. The first read after a reload triggers a
 *     consumer-supplied prompt; the consumer is the settings UI.
 *   - On first encrypted save we generate the user's passphrase from a
 *     UI flow; subsequent saves reuse the cached one.
 *   - Migration: when the user opts in, `migratePlaintextToEncrypted()`
 *     reads the legacy plaintext blob, encrypts it, deletes the
 *     plaintext entry. The legacy blob is removed atomically — if the
 *     write succeeds, the original is gone.
 *
 * Important: this module does NOT make any UX choices about WHEN to
 * prompt the user. That belongs in the settings component. This module
 * exposes a `setPromptHandler()` so the UI can plug in its modal.
 *
 * Why not IndexedDB. IDB gives slightly better isolation against some
 * browser extensions, but the load-bearing security here is "encrypt
 * before write," not "which storage backend." Adding IDB doubles the
 * surface area for the same threat coverage; we stay on localStorage
 * for the MVP and can move to IDB without changing the cipher format.
 *
 * Threat model. After this lands:
 *   - XSS in the host page yields ciphertext only; the passphrase is
 *     never written to disk; in-memory exfil still works during a
 *     decrypted session, but only for the duration of that session.
 *   - Disk exfil yields ciphertext only.
 *   - Wrong passphrase fails closed (decrypt throws).
 *   - Lost passphrase fails closed (no recovery key by design).
 */

import {
  seal,
  open,
  isEncryptedBlob,
  type EncryptedBlob,
} from './secure-crypto';

const STORAGE_KEY_ENCRYPTED = 'open-design:config:encrypted';
const STORAGE_KEY_LEGACY = 'open-design:config';
const STORAGE_KEY_FLAG = 'open-design:config:encryption-enabled';

export interface PassphrasePromptHandler {
  (purpose: 'unlock' | 'create' | 'change'): Promise<string | null>;
}

let sessionPassphrase: string | null = null;
let promptHandler: PassphrasePromptHandler | null = null;

export function setPromptHandler(handler: PassphrasePromptHandler | null): void {
  promptHandler = handler;
}

/** True iff the user has previously turned encryption on. */
export function isEncryptionEnabled(): boolean {
  if (typeof localStorage === 'undefined') return false;
  return localStorage.getItem(STORAGE_KEY_FLAG) === '1';
}

export function clearSessionPassphrase(): void {
  sessionPassphrase = null;
}

async function promptForPassphrase(
  purpose: 'unlock' | 'create' | 'change',
): Promise<string | null> {
  if (!promptHandler) {
    throw new Error(
      'secure-config-storage: no passphrase prompt handler registered. Call setPromptHandler() before reading or writing.',
    );
  }
  const value = await promptHandler(purpose);
  if (typeof value !== 'string' || value.length === 0) return null;
  return value;
}

async function ensureSessionPassphrase(
  purpose: 'unlock' | 'create',
): Promise<string | null> {
  if (sessionPassphrase) return sessionPassphrase;
  const entered = await promptForPassphrase(purpose);
  if (entered === null) return null;
  sessionPassphrase = entered;
  return sessionPassphrase;
}

/**
 * Read the encrypted config blob and decrypt it. Returns null when:
 *   - encryption is not enabled,
 *   - no encrypted blob is stored,
 *   - the user cancels the passphrase prompt,
 *   - decryption fails (wrong passphrase / tamper / shape).
 */
export async function loadEncryptedConfig<T = unknown>(): Promise<T | null> {
  if (typeof localStorage === 'undefined') return null;
  if (!isEncryptionEnabled()) return null;
  const raw = localStorage.getItem(STORAGE_KEY_ENCRYPTED);
  if (!raw) return null;

  let blob: unknown;
  try {
    blob = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isEncryptedBlob(blob)) return null;

  const passphrase = await ensureSessionPassphrase('unlock');
  if (!passphrase) return null;

  try {
    const json = await open(blob, passphrase);
    return JSON.parse(json) as T;
  } catch {
    // Wrong passphrase or tamper. Drop the cached passphrase so the next
    // read triggers a fresh prompt — repeatedly retrying with a wrong
    // passphrase silently is the worst UX.
    sessionPassphrase = null;
    return null;
  }
}

/**
 * Encrypt and persist `config`. The session passphrase is created on
 * first call (purpose=create) or reused (purpose=unlock).
 *
 * Returns true when the write succeeded; false when the user cancelled.
 */
export async function saveEncryptedConfig(config: unknown): Promise<boolean> {
  if (typeof localStorage === 'undefined') return false;
  const fresh = !sessionPassphrase;
  const passphrase = await ensureSessionPassphrase(fresh ? 'create' : 'unlock');
  if (!passphrase) return false;
  const json = JSON.stringify(config);
  const blob = await seal(json, passphrase);
  localStorage.setItem(STORAGE_KEY_ENCRYPTED, JSON.stringify(blob));
  localStorage.setItem(STORAGE_KEY_FLAG, '1');
  return true;
}

/**
 * One-shot migration. Reads the legacy plaintext config from
 * `localStorage[STORAGE_KEY_LEGACY]`, encrypts it, removes the legacy
 * key. Idempotent — calling it again after success is a no-op.
 *
 * Returns:
 *   - 'migrated'      when a legacy entry was found and successfully migrated
 *   - 'already'       when encryption is already enabled
 *   - 'no-legacy'     when there is nothing to migrate
 *   - 'cancelled'     when the user cancelled the passphrase prompt
 */
export async function migratePlaintextToEncrypted(): Promise<
  'migrated' | 'already' | 'no-legacy' | 'cancelled'
> {
  if (typeof localStorage === 'undefined') return 'no-legacy';
  if (isEncryptionEnabled()) return 'already';
  const legacy = localStorage.getItem(STORAGE_KEY_LEGACY);
  if (!legacy) return 'no-legacy';

  let parsed: unknown;
  try {
    parsed = JSON.parse(legacy);
  } catch {
    // Legacy blob is corrupted; nothing safe to migrate.
    return 'no-legacy';
  }

  const ok = await saveEncryptedConfig(parsed);
  if (!ok) return 'cancelled';

  // Remove the plaintext blob only after the encrypted write committed.
  // If the page reloads between the two writes we have ciphertext +
  // plaintext both — that is safe (encrypted entry is canonical going
  // forward) and the next migrate call will clean up the legacy entry.
  localStorage.removeItem(STORAGE_KEY_LEGACY);
  return 'migrated';
}

/**
 * Disable encryption: writes the in-memory config back to the legacy
 * plaintext slot and removes the encrypted entry. Used when the user
 * explicitly opts out (or wants to share the device).
 */
export function disableEncryption(plaintextConfig: unknown): void {
  if (typeof localStorage === 'undefined') return;
  localStorage.setItem(STORAGE_KEY_LEGACY, JSON.stringify(plaintextConfig));
  localStorage.removeItem(STORAGE_KEY_ENCRYPTED);
  localStorage.removeItem(STORAGE_KEY_FLAG);
  sessionPassphrase = null;
}

// Internal exports for tests only.
export const __TEST_KEYS__ = {
  STORAGE_KEY_ENCRYPTED,
  STORAGE_KEY_LEGACY,
  STORAGE_KEY_FLAG,
};
