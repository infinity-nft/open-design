const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  pickFolder: (): Promise<string | null> =>
    ipcRenderer.invoke('dialog:pick-folder'),
  captureRegion: (rect: { x: number; y: number; width: number; height: number }): Promise<string> =>
    ipcRenderer.invoke('capture:region', rect),
});
