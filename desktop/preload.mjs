import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('api', {
  core: (op, args) => ipcRenderer.invoke('core', op, args),
  coreStatus: () => ipcRenderer.invoke('core:status'),
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
});
