import { describe, expect, it } from 'vitest';
import {
  seal,
  open,
  isEncryptedBlob,
  ENCRYPTED_BLOB_VERSION,
  type EncryptedBlob,
} from './secure-crypto';

const PASSPHRASE = 'correct horse battery staple';

describe('secure-crypto seal/open', () => {
  it('round-trips a typical API key', async () => {
    const plaintext = 'sk-ant-api03-abc-' + 'x'.repeat(100);
    const blob = await seal(plaintext, PASSPHRASE);
    const decoded = await open(blob, PASSPHRASE);
    expect(decoded).toBe(plaintext);
  });

  it('round-trips JSON config blobs containing keys', async () => {
    const plaintext = JSON.stringify({
      mode: 'api',
      apiKey: 'sk-ant-...',
      mediaProviders: { openai: { apiKey: 'sk-...' } },
    });
    const blob = await seal(plaintext, PASSPHRASE);
    expect(await open(blob, PASSPHRASE)).toBe(plaintext);
  });

  it('produces a fresh salt and IV on every seal so identical inputs differ', async () => {
    const a = await seal('same plaintext', PASSPHRASE);
    const b = await seal('same plaintext', PASSPHRASE);
    expect(a.salt).not.toBe(b.salt);
    expect(a.iv).not.toBe(b.iv);
    expect(a.ct).not.toBe(b.ct);
  });

  it('rejects open with the wrong passphrase', async () => {
    const blob = await seal('secret', PASSPHRASE);
    await expect(open(blob, 'wrong passphrase')).rejects.toThrow(/decryption failed/);
  });

  it('rejects open when ciphertext is tampered', async () => {
    const blob = await seal('secret', PASSPHRASE);
    const tampered: EncryptedBlob = {
      ...blob,
      // Flip the last byte of the base64 ciphertext.
      ct: blob.ct.slice(0, -2) + (blob.ct.endsWith('A=') ? 'B=' : 'A='),
    };
    await expect(open(tampered, PASSPHRASE)).rejects.toThrow(/decryption failed/);
  });

  it('rejects malformed blobs (shape mismatch)', async () => {
    await expect(open({} as never, PASSPHRASE)).rejects.toThrow(/expected an EncryptedBlob/);
    await expect(open(null as never, PASSPHRASE)).rejects.toThrow();
  });

  it('rejects empty passphrases on both seal and open', async () => {
    await expect(seal('x', '')).rejects.toThrow(/passphrase must be a non-empty/);
    const blob = await seal('x', PASSPHRASE);
    await expect(open(blob, '')).rejects.toThrow(/passphrase must be a non-empty/);
  });

  it('emits a self-describing envelope with version and algorithm', async () => {
    const blob = await seal('hi', PASSPHRASE);
    expect(blob.v).toBe(ENCRYPTED_BLOB_VERSION);
    expect(blob.algo).toBe('aes-256-gcm/pbkdf2-sha256');
    expect(blob.iter).toBeGreaterThanOrEqual(600_000);
    expect(isEncryptedBlob(blob)).toBe(true);
  });

  it('isEncryptedBlob rejects shapes that look similar but are not', () => {
    expect(isEncryptedBlob({ v: 0, algo: 'aes-256-gcm/pbkdf2-sha256', iter: 1, salt: '', iv: '', ct: '' })).toBe(false);
    expect(isEncryptedBlob({ v: 1, algo: 'other', iter: 1, salt: '', iv: '', ct: '' })).toBe(false);
    expect(isEncryptedBlob({ v: 1, algo: 'aes-256-gcm/pbkdf2-sha256', iter: 'no', salt: '', iv: '', ct: '' })).toBe(false);
    expect(isEncryptedBlob('plain string')).toBe(false);
    expect(isEncryptedBlob(null)).toBe(false);
    expect(isEncryptedBlob(undefined)).toBe(false);
  });

  it('survives a JSON round-trip — the persistence layer can stringify safely', async () => {
    const blob = await seal('persist me', PASSPHRASE);
    const wire = JSON.stringify(blob);
    const recovered = JSON.parse(wire) as EncryptedBlob;
    expect(isEncryptedBlob(recovered)).toBe(true);
    expect(await open(recovered, PASSPHRASE)).toBe('persist me');
  });
});
