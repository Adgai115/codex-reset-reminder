// Preload must be CommonJS: Electron's sandbox does not support ESM preloads.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  core: (op, args) => ipcRenderer.invoke('core', op, args),
  coreStatus: () => ipcRenderer.invoke('core:status'),
  onReminderData: (callback) => ipcRenderer.on('reminder:data', (_event, payload) => callback(payload)),
  reminderAction: (action, option) => ipcRenderer.invoke('reminder:act', action, option),
});
