# `apps/web/src/security/`

BYOK key encryption for Topology C (web on Vercel + direct API in browser).

This directory replaces the legacy plaintext-`localStorage` storage of API
keys with passphrase-based AES-256-GCM encryption. See
[`specs/current/master-plan-2026-05.md`](../../../../specs/current/master-plan-2026-05.md)
T0.5 for the rationale and
[`docs/prompt-engineering.md`](../../../../docs/prompt-engineering.md)
Layer 3 for the broader threat model.

## Modules

- **`secure-crypto.ts`** — pure SubtleCrypto wrapper. PBKDF2-SHA-256
  (600 000 iter) → AES-256-GCM. `seal()` / `open()` are the only two
  exported functions. The rest is a versioned JSON envelope.
- **`secure-config-storage.ts`** — persistence layer over
  `localStorage`. Handles legacy-plaintext migration, the in-memory
  passphrase cache, and the consumer-supplied passphrase prompt.
- **`*.test.ts`** — full coverage for round-trip, wrong passphrase,
  tampered ciphertext, migration, opt-out.

## Status

The crypto and storage primitives are landed. The settings UI that
(a) prompts the user for a passphrase the first time and (b) calls
`migratePlaintextToEncrypted()` on opt-in is **not yet wired**. This is
intentional — the UX choices below need product input first.

## Open UX questions before turning the flag on

1. **When is the prompt shown?**
   - Once per page load? Once per browser session? Idle timeout?
   - Recommendation: once per page load (simplest, matches macOS Keychain
     unlock UX), with an "Unlock now" affordance in the settings header.
2. **Where does the prompt live?**
   - Modal overlay vs. inline form in settings.
   - Recommendation: modal overlay; key access is rare enough that
     interrupting flow is acceptable, and a modal is a clearer trust
     signal than an inline field.
3. **Recovery flow when passphrase is forgotten?**
   - There is no recovery by design (the data is encrypted with a key
     derived from the passphrase). The UX must communicate this clearly
     before a passphrase is set.
   - Recommendation: passphrase-creation modal includes a "this cannot
     be recovered — write it down" checkbox the user must tick.
4. **Migration prompt copy?**
   - First load after the flag flips: "We're upgrading your stored API
     keys to encrypted storage. Set a passphrase below."

Until these are answered the modules ship dormant. Calling them with no
prompt handler throws a helpful error rather than silently trying.

## How to wire it (once the UX is approved)

```ts
import {
  setPromptHandler,
  migratePlaintextToEncrypted,
  loadEncryptedConfig,
  saveEncryptedConfig,
  isEncryptionEnabled,
} from './security/secure-config-storage';

// 1. At app boot, register the prompt handler. The handler returns
//    a passphrase string from the modal, or null on cancel.
setPromptHandler(async (purpose) => openPassphraseModal(purpose));

// 2. On first opt-in (settings toggle), migrate.
const result = await migratePlaintextToEncrypted();
// 'migrated' | 'already' | 'no-legacy' | 'cancelled'

// 3. In `loadConfig()` / `saveConfig()`, branch on isEncryptionEnabled()
//    and call the encrypted path when on, the legacy path otherwise.
```

The legacy path in `state/config.ts` should remain untouched until
encryption is the default — keeping both paths means a flag can roll
back safely.
