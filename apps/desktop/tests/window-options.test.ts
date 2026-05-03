import { describe, expect, it } from 'vitest';
import { WINDOW_WEB_PREFERENCES } from '../src/main/window-options.js';

// Electron security baseline per P1-4.
// These assertions codify the BrowserWindow settings that prevent
// renderer-side code from escalating to Node / main-process privileges.
describe('BrowserWindow security settings', () => {
  it('contextIsolation is on — prevents renderer from accessing Node globals', () => {
    expect(WINDOW_WEB_PREFERENCES.contextIsolation).toBe(true);
  });

  it('nodeIntegration is off — renderer cannot require() Node modules', () => {
    expect(WINDOW_WEB_PREFERENCES.nodeIntegration).toBe(false);
  });

  it('sandbox is on — renderer runs in OS-level sandboxed process', () => {
    expect(WINDOW_WEB_PREFERENCES.sandbox).toBe(true);
  });

  it('webSecurity is on — same-origin policy enforced', () => {
    expect(WINDOW_WEB_PREFERENCES.webSecurity).toBe(true);
  });

  it('allowRunningInsecureContent is off — mixed content blocked', () => {
    expect(WINDOW_WEB_PREFERENCES.allowRunningInsecureContent).toBe(false);
  });
});
