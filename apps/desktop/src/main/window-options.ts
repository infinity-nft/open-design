/**
 * BrowserWindow webPreferences used for every window the desktop app
 * creates. Exported as a named const so the unit test can assert each
 * security setting without importing Electron.
 *
 * Electron 20+ defaults: contextIsolation=true, sandbox=true,
 * nodeIntegration=false. webSecurity and allowRunningInsecureContent
 * default to safe values but are set explicitly to prevent accidental
 * override, document intent, and keep the test honest.
 */
export const WINDOW_WEB_PREFERENCES = {
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
  webSecurity: true,
  allowRunningInsecureContent: false,
} as const;
