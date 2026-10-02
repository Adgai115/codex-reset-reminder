import { app, BrowserWindow, dialog, ipcMain, net, safeStorage, session as electronSession } from 'electron';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createWechatClient } from './client.mjs';
import { WechatProbe, probeErrorMessage, SYNTHETIC_TEXT } from './controller.mjs';
import { createProbeStorage } from './storage.mjs';
import { renderQrDataUrl } from './qr.mjs';

const directory = dirname(fileURLToPath(import.meta.url));
const root = join(directory, '..', '..');
const mock = process.argv.includes('--mock') || process.argv.includes('--smoke');
const profile = join(root, '.git', mock ? 'wechat-official-probe-mock-profile' : 'wechat-official-probe-profile');
mkdirSync(join(profile, 'browser'), { recursive: true, mode: 0o700 });
app.setName('Codex 微信直连验证');
app.setPath('userData', join(profile, 'browser'));
app.disableHardwareAcceleration();
let window, probe, quitting = false, dialogBusy = false;

// An additional development instance cannot replace a running authorization.
if (!app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', () => { window?.show(); window?.focus(); });

function mockClient() {
  let deliveredContext = false;
  return {
    async requestQr() { deliveredContext = false; return { qrcode: 'mock-qr', qrcode_img_content: 'https://ilinkai.weixin.qq.com/mock-login' }; },
    async pollQr() { return { status: 'confirmed', bot_token: 'mock-credential-only', ilink_user_id: 'mock-peer', baseurl: 'https://ilinkai.weixin.qq.com' }; },
    async notify() {},
    async getUpdates(_session, { signal }) {
      if (!deliveredContext) {
        deliveredContext = true;
        return { ret: 0, get_updates_buf: 'mock-cursor', msgs: [
          { from_user_id: 'mock-peer', message_type: 1, context_token: 'mock-context' },
        ] };
      }
      await new Promise((resolve) => {
        if (signal.aborted) return resolve();
        signal.addEventListener('abort', resolve, { once: true });
      });
      return { ret: 0, msgs: [] };
    },
    async sendText() { return { ok: true, confirmation: 'accepted' }; },
  };
}

function trusted(event) {
  return !quitting && window && !window.isDestroyed()
    && event.sender === window.webContents
    && event.senderFrame === window.webContents.mainFrame
    && event.senderFrame.url === pathToFileURL(join(directory, 'ui', 'index.html')).href;
}
async function confirm(title, message) {
  const result = await dialog.showMessageBox(window, { type: 'question', title,
    message, buttons: ['取消', '继续'], defaultId: 0, cancelId: 0, noLink: true });
  return result.response === 1;
}
function handle(name, action) {
  ipcMain.handle(`wechat-probe:${name}`, async (event, input) => {
    if (!trusted(event)) return { ok: false, error: '此窗口无权访问微信验证操作。' };
    if (dialogBusy && name !== 'status') return { ok: false, error: '请先完成当前确认。', status: probe.status() };
    try {
      await action(input);
      return { ok: true, status: probe.status() };
    } catch (error) { return { ok: false, error: probeErrorMessage(error), status: probe.status() }; }
  });
}
async function confirmed(title, message, operation) {
  probe.available(); dialogBusy = true;
  try { if (await confirm(title, message)) await operation(); }
  finally { dialogBusy = false; }
}

app.whenReady().then(async () => {
  const partition = 'wechat-official-probe';
  // The page can only load its local files. API requests stay in the main process.
  const isolatedSession = electronSession.fromPartition(partition);
  const uiBase = pathToFileURL(join(directory, 'ui')).href + '/';
  isolatedSession.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: !details.url.startsWith(uiBase) && !details.url.startsWith('data:') });
  });
  window = new BrowserWindow({ width: 640, height: 800, minWidth: 560, minHeight: 650,
    show: false, title: mock ? '微信直连验证 · 模拟环境' : '微信直连验证',
    autoHideMenuBar: true,
    webPreferences: { preload: join(directory, 'ui', 'preload.cjs'), partition,
      contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  const storage = createProbeStorage(profile, safeStorage);
  probe = new WechatProbe({ client: mock ? mockClient() : createWechatClient({ fetchImpl: net.fetch.bind(net) }),
    storage, renderQr: renderQrDataUrl,
    publish(status) { if (!window.isDestroyed()) window.webContents.send('wechat-probe:changed', status); },
  });
  handle('status', async () => {});
  handle('login', () => probe.login());
  handle('verify-code', (code) => probe.verifyCode(code));
  handle('send', (input) => {
    if (!input || Object.keys(input).some((key) => key !== 'omitContext') || typeof input.omitContext !== 'boolean')
      throw Object.assign(new Error('测试参数无效。'), { code: 'PROBE_STATE' });
    return confirmed('发送微信模拟提醒', `${input.omitContext ? '本次实验省略会话上下文。\n\n' : ''}${SYNTHETIC_TEXT}`, () => probe.send(input));
  });
  handle('schedule', (minutes) => {
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 2160)
      throw Object.assign(new Error('延迟分钟数无效。'), { code: 'PROBE_STATE' });
    return confirmed('安排微信延迟测试', `${minutes} 分钟后发送一条模拟提醒。\n请保持电脑在线、验证工具运行。关闭工具将取消计划。`, () => probe.schedule(minutes));
  });
  handle('cancel', () => probe.cancelSchedule());
  handle('confirm', (id) => probe.confirm(id));
  handle('forget', () => confirmed('清除测试连接', '仅清除本机微信验证凭据和测试记录。微信侧解绑需在微信中操作。', () => probe.forget()));
  await window.loadFile(join(directory, 'ui', 'index.html'));
  try { await probe.initialize(); }
  catch { probe.phase = 'error'; probe.message = '本机测试连接无法恢复，请清除测试连接后重新扫码。'; await probe.emit(); }
  window.show();
  if (process.argv.includes('--start-login') && !probe.session) await probe.login().catch(() => {});
  window.on('close', (event) => {
    if (quitting) return;
    event.preventDefault();
    if (dialogBusy || probe.busy) return;
    (async () => {
      dialogBusy = true;
      try {
        if (probe.scheduled && !(await confirm('退出微信验证', '退出将取消尚未发送的延迟测试。'))) return;
        quitting = true; await probe.stop(); app.quit();
      } finally { dialogBusy = false; }
    })().catch(() => { quitting = true; app.quit(); });
  });
  if (process.argv.includes('--smoke')) {
    await probe.forget(); await probe.login();
    const deadline = Date.now() + 5000;
    while (!probe.status().hasContext && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
    if (!probe.status().hasContext) throw new Error('MOCK_BIND_FAILED');
    await probe.send();
    if (probe.status().tests[0]?.confirmation !== 'accepted') throw new Error('MOCK_SEND_FAILED');
    await probe.confirm(probe.status().tests[0].id);
    await probe.schedule(1500); await probe.cancelSchedule();
    const html = await window.webContents.executeJavaScript('document.documentElement.scrollWidth <= innerWidth && Boolean(window.wechatProbe)');
    if (!html) throw new Error('MOCK_RENDER_FAILED');
    process.stdout.write('WECHAT_PROBE_SMOKE_OK\n');
    quitting = true; await probe.stop(); app.quit();
  }
}).catch(() => {
  process.stderr.write('微信验证工具启动失败（未输出凭据或接口正文）。\n');
  quitting = true; app.exit(1);
});
app.on('window-all-closed', () => { if (!quitting) { quitting = true; probe?.stop().finally(() => app.quit()); } });
