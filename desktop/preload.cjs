// Preload must be CommonJS: Electron's sandbox does not support ESM preloads.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  core: (op, args) => ipcRenderer.invoke('core', op, args),
  coreStatus: () => ipcRenderer.invoke('core:status'),
  onReminderData: (callback) => ipcRenderer.on('reminder:data', (_event, payload) => callback(payload)),
  reminderAction: (action, option) => ipcRenderer.invoke('reminder:act', action, option),
  setupDiscover: () => ipcRenderer.invoke('setup:discover'),
  setupBrowse: () => ipcRenderer.invoke('setup:browse'),
  setupSave: (options) => ipcRenderer.invoke('setup:save', options),
  openSettings: () => ipcRenderer.invoke('settings:open'),
  settingsRead: () => ipcRenderer.invoke('settings:read'),
  settingsSave: (settings) => ipcRenderer.invoke('settings:save', settings),
  settingsClose: () => ipcRenderer.invoke('settings:close'),
  feishuConnect: (settings) => ipcRenderer.invoke('feishu:connect', settings),
  testDesktopReminder: () => ipcRenderer.invoke('settings:testDesktop'),
});
