// Preload must be CommonJS: Electron's sandbox does not support ESM preloads.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  core: (op, args) => ipcRenderer.invoke('core', op, args),
  coreStatus: () => ipcRenderer.invoke('core:status'),
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
});
