// Electron sandbox preloads use CommonJS and expose only the probe's fixed API.
const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args).catch(() => ({
  ok: false,
  error: '本地验证工具通信失败，请重新打开窗口后重试。',
}));

contextBridge.exposeInMainWorld('wechatProbe', {
  status: () => invoke('wechat-probe:status'),
  login: () => invoke('wechat-probe:login'),
  verifyCode: (code) => invoke('wechat-probe:verify-code', code),
  send: (options) => invoke('wechat-probe:send', options),
  schedule: (delayMinutes) => invoke('wechat-probe:schedule', delayMinutes),
  cancel: () => invoke('wechat-probe:cancel'),
  confirm: (testId) => invoke('wechat-probe:confirm', testId),
  forget: () => invoke('wechat-probe:forget'),
  onStatus: (callback) => {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, status) => callback(status);
    ipcRenderer.on('wechat-probe:changed', listener);
    return () => ipcRenderer.removeListener('wechat-probe:changed', listener);
  },
});
