// Preload must be CommonJS: Electron's sandbox does not support ESM preloads.
const { contextBridge, ipcRenderer } = require('electron');
const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args).catch((error) => {
  // Electron 自动添加的 IPC 包装信息不应出现在用户提示里。
  throw new Error(String(error.message).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, ''));
});

contextBridge.exposeInMainWorld('api', {
  core: (op, args) => invoke('core', op, args),
  coreStatus: () => invoke('core:status'),
  loginAccount: (scopeId) => invoke('accounts:login', scopeId),
  cancelAccountLogin: () => invoke('accounts:cancelLogin'),
  quitApp: () => invoke('app:quit'),
  onStateChanged: (callback) => {
    const listener = () => callback();
    ipcRenderer.on('state:changed', listener);
    return () => ipcRenderer.removeListener('state:changed', listener);
  },
  onReminderData: (callback) => ipcRenderer.on('reminder:data', (_event, payload) => callback(payload)),
  reminderAction: (action, args) => invoke('reminder:act', action, args),
  openPendingReminders: (cardId) => invoke('reminders:openPending', cardId),
  setupDiscover: () => invoke('setup:discover'),
  setupProbeCodex: (path) => invoke('setup:probeCodex', path),
  setupBrowse: () => invoke('setup:browse'),
  setupSave: (options) => invoke('setup:save', options),
  openSettings: (tab) => invoke('settings:open', tab),
  onSettingsTab: (callback) => {
    const listener = (_event, tab) => callback(tab);
    ipcRenderer.on('settings:tab', listener);
    return () => ipcRenderer.removeListener('settings:tab', listener);
  },
  viewAccount: (scopeId) => invoke('settings:viewAccount', scopeId),
  settingsRead: () => invoke('settings:read'),
  listenerStatus: () => invoke('settings:listenerStatus'),
  diagnoseLocal: () => invoke('settings:diagnoseLocal'),
  probeCodex: () => invoke('settings:probeCodex'),
  repairCodex: () => invoke('settings:repairCodex'),
  checkUpdates: () => invoke('settings:checkUpdates'),
  updateStatus: () => invoke('settings:updateStatus'),
  onUpdateStatus: (callback) => {
    const listener = (_event, status) => callback(status);
    ipcRenderer.on('update:status', listener);
    return () => ipcRenderer.removeListener('update:status', listener);
  },
  downloadUpdate: () => invoke('settings:downloadUpdate'),
  installUpdate: () => invoke('settings:installUpdate'),
  openUpdate: () => invoke('settings:openUpdate'),
  settingsSave: (settings) => invoke('settings:save', settings),
  settingsDraft: (state) => invoke('settings:draft', state),
  settingsClose: () => invoke('settings:close'),
  feishuConnect: (settings) => invoke('feishu:connect', settings),
  testDesktopReminder: () => invoke('settings:testDesktop'),
});
