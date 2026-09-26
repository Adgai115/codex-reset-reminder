// Preload must be CommonJS: Electron's sandbox does not support ESM preloads.
const { contextBridge, ipcRenderer } = require('electron');
const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args).catch((error) => {
  // Electron 自动添加的 IPC 包装信息不应出现在用户提示里。
  throw new Error(String(error.message).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, ''));
});

contextBridge.exposeInMainWorld('api', {
  core: (op, args) => invoke('core', op, args),
  coreStatus: () => invoke('core:status'),
  onStateChanged: (callback) => {
    const listener = () => callback();
    ipcRenderer.on('state:changed', listener);
    return () => ipcRenderer.removeListener('state:changed', listener);
  },
  onReminderData: (callback) => ipcRenderer.on('reminder:data', (_event, payload) => callback(payload)),
  reminderAction: (action, option) => invoke('reminder:act', action, option),
  setupDiscover: () => invoke('setup:discover'),
  setupProbeCodex: (path) => invoke('setup:probeCodex', path),
  setupBrowse: () => invoke('setup:browse'),
  setupSave: (options) => invoke('setup:save', options),
  openSettings: () => invoke('settings:open'),
  settingsRead: () => invoke('settings:read'),
  listenerStatus: () => invoke('settings:listenerStatus'),
  diagnoseLocal: () => invoke('settings:diagnoseLocal'),
  probeCodex: () => invoke('settings:probeCodex'),
  repairCodex: () => invoke('settings:repairCodex'),
  checkUpdates: () => invoke('settings:checkUpdates'),
  openUpdate: () => invoke('settings:openUpdate'),
  settingsSave: (settings) => invoke('settings:save', settings),
  settingsDraft: (state) => invoke('settings:draft', state),
  settingsClose: () => invoke('settings:close'),
  feishuConnect: (settings) => invoke('feishu:connect', settings),
  testDesktopReminder: () => invoke('settings:testDesktop'),
});
