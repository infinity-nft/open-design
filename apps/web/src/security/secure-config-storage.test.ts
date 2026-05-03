import { describe, expect, it, beforeEach, vi } from 'vitest';
import {
  loadEncryptedConfig,
  saveEncryptedConfig,
  migratePlaintextToEncrypted,
  disableEncryption,
  isEncryptionEnabled,
  setPromptHandler,
  clearSessionPassphrase,
  __TEST_KEYS__,
} from './secure-config-storage';

function memoryLocalStorage(): Storage {
  let data: Record<string, string> = {};
  return {
    get length() {
      return Object.keys(data).length;
    },
    clear() {
      data = {};
    },
    getItem(key: string) {
      return key in data ? data[key]! : null;
    },
    key(i: number) {
      return Object.keys(data)[i] ?? null;
    },
    removeItem(key: string) {
      delete data[key];
    },
    setItem(key: string, value: string) {
      data[key] = String(value);
    },
  };
}

describe('secure-config-storage', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', memoryLocalStorage());
    setPromptHandler(null);
    clearSessionPassphrase();
  });

  it('round-trips a config through save → load', async () => {
    setPromptHandler(async () => 'pass-1');
    const config = { mode: 'api', apiKey: 'sk-secret', model: 'claude-sonnet-4-5' };
    const ok = await saveEncryptedConfig(config);
    expect(ok).toBe(true);
    expect(isEncryptionEnabled()).toBe(true);

    // The localStorage entry must be a JSON-encoded EncryptedBlob, not
    // the raw config — XSS that reads localStorage gets nothing useful.
    const stored = localStorage.getItem(__TEST_KEYS__.STORAGE_KEY_ENCRYPTED);
    expect(stored).toBeTruthy();
    expect(stored).not.toContain('sk-secret');
    const parsed = JSON.parse(stored!);
    expect(parsed.algo).toBe('aes-256-gcm/pbkdf2-sha256');

    // Load uses the cached session passphrase.
    const loaded = await loadEncryptedConfig<typeof config>();
    expect(loaded).toEqual(config);
  });

  it('returns null when the user cancels the unlock prompt', async () => {
    setPromptHandler(async () => 'unlock-me');
    await saveEncryptedConfig({ apiKey: 'k' });

    // New session: passphrase cache cleared, prompt cancels.
    clearSessionPassphrase();
    setPromptHandler(async () => null);
    const loaded = await loadEncryptedConfig();
    expect(loaded).toBeNull();
  });

  it('returns null on wrong passphrase and clears the cache', async () => {
    setPromptHandler(async () => 'right-pass');
    await saveEncryptedConfig({ apiKey: 'k' });

    clearSessionPassphrase();
    setPromptHandler(async () => 'wrong-pass');
    const loaded = await loadEncryptedConfig();
    expect(loaded).toBeNull();
  });

  it('migratePlaintextToEncrypted moves legacy → encrypted and removes legacy', async () => {
    // Seed legacy plaintext.
    const legacy = { apiKey: 'sk-legacy', model: 'm' };
    localStorage.setItem(
      __TEST_KEYS__.STORAGE_KEY_LEGACY,
      JSON.stringify(legacy),
    );

    setPromptHandler(async () => 'migrate-pass');
    const result = await migratePlaintextToEncrypted();
    expect(result).toBe('migrated');
    expect(localStorage.getItem(__TEST_KEYS__.STORAGE_KEY_LEGACY)).toBeNull();
    expect(isEncryptionEnabled()).toBe(true);

    // Encrypted blob is decryptable to the original payload.
    const loaded = await loadEncryptedConfig<typeof legacy>();
    expect(loaded).toEqual(legacy);
  });

  it('migratePlaintextToEncrypted is a no-op when nothing to migrate', async () => {
    setPromptHandler(async () => 'unused');
    expect(await migratePlaintextToEncrypted()).toBe('no-legacy');
  });

  it('migratePlaintextToEncrypted is a no-op when already encrypted', async () => {
    setPromptHandler(async () => 'pass');
    await saveEncryptedConfig({ k: 1 });
    // Even with a stale legacy entry present, migrate must not clobber.
    localStorage.setItem(
      __TEST_KEYS__.STORAGE_KEY_LEGACY,
      JSON.stringify({ stale: true }),
    );
    expect(await migratePlaintextToEncrypted()).toBe('already');
  });

  it('migratePlaintextToEncrypted reports cancelled when prompt returns null', async () => {
    localStorage.setItem(
      __TEST_KEYS__.STORAGE_KEY_LEGACY,
      JSON.stringify({ k: 1 }),
    );
    setPromptHandler(async () => null);
    expect(await migratePlaintextToEncrypted()).toBe('cancelled');
    // Migration didn't run, so encryption flag stays off and legacy
    // entry is preserved — the user can try again later.
    expect(isEncryptionEnabled()).toBe(false);
    expect(localStorage.getItem(__TEST_KEYS__.STORAGE_KEY_LEGACY)).toBeTruthy();
  });

  it('disableEncryption restores plaintext path', async () => {
    setPromptHandler(async () => 'p');
    await saveEncryptedConfig({ apiKey: 'sk' });
    expect(isEncryptionEnabled()).toBe(true);

    disableEncryption({ apiKey: 'sk', after: true });
    expect(isEncryptionEnabled()).toBe(false);
    expect(localStorage.getItem(__TEST_KEYS__.STORAGE_KEY_ENCRYPTED)).toBeNull();
    expect(localStorage.getItem(__TEST_KEYS__.STORAGE_KEY_LEGACY)).toContain(
      '"after":true',
    );
  });

  it('throws a helpful error when no prompt handler is registered', async () => {
    // No setPromptHandler call.
    await expect(saveEncryptedConfig({ k: 1 })).rejects.toThrow(
      /no passphrase prompt handler registered/,
    );
  });
});
