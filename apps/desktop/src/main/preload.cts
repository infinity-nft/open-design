const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  openExternal: (url: string): Promise<boolean> =>
    ipcRenderer.invoke('shell:open-external', url),
  pickFolder: (): Promise<string | null> =>
    ipcRenderer.invoke('dialog:pick-folder'),
  captureRegion: (rect: { x: number; y: number; width: number; height: number }): Promise<string> =>
    ipcRenderer.invoke('capture:region', rect),
});
