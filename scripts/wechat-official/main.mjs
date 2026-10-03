import { app, BrowserWindow, dialog, ipcMain, nativeTheme, net, safeStorage, session as electronSession } from 'electron';
import { mkdirSync } from 'node:fs';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createWechatClient } from './client.mjs';
import { WechatProbe, probeErrorMessage, SYNTHETIC_TEXT } from './controller.mjs';
import { createProbeStorage } from './storage.mjs';
import { renderQrDataUrl } from './qr.mjs';
import { WechatGateway } from './gateway.mjs';
import { createSharedWechatSender } from './shared-send.mjs';
import { requestLocalWechatNotification } from '../../core/wechat-local-http.mjs';
import { invokeWechatLocalClient } from '../../core/wechat-local-client.mjs';
import { exportLocalWechatClient } from '../../desktop/wechat-local-export.mjs';

const directory = dirname(fileURLToPath(import.meta.url));
const root = join(directory, '..', '..');
const mock = process.argv.includes('--mock') || process.argv.includes('--smoke');
const profile = join(root, '.git', mock ? 'wechat-official-probe-mock-profile' : 'wechat-official-probe-profile');
mkdirSync(join(profile, 'browser'), { recursive: true, mode: 0o700 });
app.setName('Codex 微信直连验证');
app.setPath('userData', join(profile, 'browser'));
app.disableHardwareAcceleration();
let window, probe, gateway, gatewayStorage, quitting = false, dialogBusy = false;

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
function publicStatus() {
  const shared = gateway?.status() ?? { running: false, clients: [], receipts: [] };
  return { ...probe.status(), gateway: probe.session ? shared : { ...shared, clients: [], receipts: [] } };
}
function publish() {
  if (window && !window.isDestroyed() && probe) window.webContents.send('wechat-probe:changed', publicStatus());
}
function mainProblem(message) { return Object.assign(new Error(message), { code: 'PROBE_STATE' }); }
function operationMessage(error) {
  return ({ WECHAT_LOCAL_CAPACITY: '共享来源或通知记录已达容量上限，旧记录仍保留。',
    WECHAT_LOCAL_STORAGE: '本机共享记录无法保存，请检查磁盘空间和目录权限。',
    WECHAT_LOCAL_OFFLINE: '本机通知共享已关闭，请先开启共享。',
    WECHAT_LOCAL_INVALID: '共享来源参数无效。',
    WECHAT_LOCAL_NOT_FOUND: '共享来源不存在，请刷新后重试。' })[error?.code] || probeErrorMessage(error);
}
async function confirm(title, message) {
  const result = await dialog.showMessageBox(window, { type: 'question', title,
    message, buttons: ['取消', '继续'], defaultId: 0, cancelId: 0, noLink: true });
  return result.response === 1;
}
function handle(name, action) {
  ipcMain.handle(`wechat-probe:${name}`, async (event, input) => {
    if (!trusted(event)) return { ok: false, error: '此窗口无权访问微信验证操作。' };
    if (dialogBusy && name !== 'status') return { ok: false, error: '请先完成当前确认。', status: publicStatus() };
    try {
      await action(input);
      return { ok: true, status: publicStatus() };
    } catch (error) { return { ok: false, error: operationMessage(error), status: publicStatus() }; }
  });
}
async function exportClient(label) {
  if (!gateway.status().running) throw mainProblem('请先开启本机通知共享。');
  if (typeof label !== 'string' || !label.trim() || label.length > 40 || /[\u0000-\u001f\u007f]/.test(label))
    throw mainProblem('请输入 1 至 40 个字的来源名称。');
  probe.available(); dialogBusy = true;
  let client;
  try {
    if (!safeStorage.isEncryptionAvailable() || safeStorage.getSelectedStorageBackend?.() === 'basic_text')
      throw mainProblem('系统凭据加密不可用，无法导出共享客户端。');
    const selected = await dialog.showSaveDialog(window, {
      title: '导出本机微信客户端', buttonLabel: '保存加密客户端',
      defaultPath: join(app.getPath('documents'), 'wechat-local-client.bin'),
      filters: [{ name: '本机加密客户端', extensions: ['bin'] }],
    });
    if (selected.canceled || !selected.filePath) return;
    client = await gateway.addClient(label.trim());
    const encrypted = await exportLocalWechatClient(client, { crypto: safeStorage, userData: app.getPath('userData') });
    await mkdir(dirname(selected.filePath), { recursive: true, mode: 0o700 });
    await writeFile(selected.filePath, encrypted, { mode: 0o600 });
    probe.message = '共享来源已创建，加密客户端文件仅供这台电脑上的对应 agent 使用。';
    await probe.emit();
  } catch (error) {
    if (client) await gateway.revokeClient(client.clientId).catch(() => {});
    if (error?.code === 'PROBE_STATE') throw error;
    throw mainProblem('加密客户端未能导出，请核对保存位置后重试。');
  } finally { dialogBusy = false; }
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
    publish,
  });
  gatewayStorage = createProbeStorage(profile, safeStorage, { secretName: 'gateway-state.bin', statusName: 'gateway-status.json' });
  gateway = new WechatGateway({
    storage: gatewayStorage,
    sendText: createSharedWechatSender(probe, { canSend: () => !dialogBusy }),
    discoveryPath: join(profile, 'gateway.json'), publish,
    ...(process.argv.includes('--smoke') ? { cooldownMs: 0 } : {}),
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
  handle('forget', () => confirmed('清除测试连接', '仅清除本机微信验证凭据和测试记录，并撤销全部共享来源。微信侧解绑需在微信中操作。', async () => { await gateway.reset(); await probe.forget(); }));
  handle('gateway-enable', () => confirmed('开启本机微信通知共享', '允许已授权的本机 agent 通过当前连接发送通知。通知内容会发送给微信官方；不会上传 Codex 登录凭据。\n\n这是实验功能，可在此处随时关闭。省略会话上下文和长期定时投递仍需验证。', async () => {
    if (!probe.session || probe.phase !== 'bound') throw mainProblem('请先扫码建立有效的微信连接。');
    await gateway.start(); probe.message = '本机通知共享已开启，请为需要发送通知的 agent 创建来源。'; await probe.emit();
  }));
  handle('gateway-disable', async () => { await gateway.stop(); probe.message = '本机通知共享已关闭。'; await probe.emit(); });
  handle('gateway-add-client', exportClient);
  handle('gateway-revoke-client', async (id) => {
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(id)) throw mainProblem('共享来源无效。');
    await gateway.revokeClient(id); probe.message = '此来源的微信发送权限已撤销。'; await probe.emit();
  });
  await window.loadFile(join(directory, 'ui', 'index.html'));
  try { await probe.initialize(); }
  catch { probe.phase = 'error'; probe.message = '本机测试连接无法恢复，请清除测试连接后重新扫码。'; await probe.emit(); }
  window.show();
  if (process.argv.includes('--start-login') && !probe.session) await probe.login().catch(() => {});
  window.on('close', (event) => {
    if (quitting) return;
    event.preventDefault();
    if (dialogBusy || (probe.busy && !gateway.status().sending)) return;
    (async () => {
      dialogBusy = true;
      try {
        if (probe.scheduled && !(await confirm('退出微信验证', '退出将取消尚未发送的延迟测试。'))) return;
        quitting = true; await gateway.stop(); await probe.stop(); app.quit();
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
    // The smoke profile has a fake WeChat client; no real API or credential is used.
    probe.cooldownMs = 0; probe.lastSendAt = -Infinity;
    await gateway.reset(); await gateway.start();
    const firstClient = await gateway.addClient('模拟 Agent A');
    const secondClient = await gateway.addClient('模拟 Agent B');
    const first = await requestLocalWechatNotification(firstClient, { id: 'mock-shared-a', title: '共享测试', text: '模拟通知 A，不含真实资料。' });
    const clientFile = join(profile, 'mock-client-b.bin');
    let second;
    try {
      await writeFile(clientFile, await exportLocalWechatClient(secondClient, { crypto: safeStorage, userData: app.getPath('userData') }), { mode: 0o600 });
      second = await invokeWechatLocalClient({ electronPath: process.execPath, clientFile,
        request: { id: 'mock-shared-b', title: '共享测试', text: '模拟通知 B，不含真实资料。' }, timeoutMs: 10000 });
    } finally { await rm(clientFile, { force: true }); }
    if (first.state !== 'accepted' || second.state !== 'accepted') {
      process.stderr.write(`MOCK_SHARED_STATES ${first.state}/${first.code} ${second.state}/${second.code}\n`);
      throw new Error('MOCK_SHARED_SEND_FAILED');
    }
    await gateway.revokeClient(firstClient.clientId);
    const revoked = await requestLocalWechatNotification(firstClient, { id: 'mock-shared-revoked', title: '共享测试', text: '这条模拟通知不能发送。' });
    if (revoked.state !== 'unsent') throw new Error('MOCK_SHARED_REVOKE_FAILED');
    const html = await window.webContents.executeJavaScript('document.documentElement.scrollWidth <= innerWidth && Boolean(window.wechatProbe?.gatewayEnable) && !JSON.stringify(document.body.textContent).includes("mock-credential-only")');
    if (!html) throw new Error('MOCK_RENDER_FAILED');
    window.setMinimumSize(0, 0);
    for (const theme of ['light', 'dark']) {
      nativeTheme.themeSource = theme;
      window.setSize(480, 740);
      await window.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
      const fits = await window.webContents.executeJavaScript('document.documentElement.scrollWidth <= innerWidth && document.querySelector("#sourceForm").scrollWidth <= document.querySelector("#sourceForm").clientWidth');
      if (!fits) throw new Error('MOCK_SHARED_LAYOUT_FAILED');
      await window.webContents.executeJavaScript('window.scrollTo(0, document.documentElement.scrollHeight); new Promise(resolve => requestAnimationFrame(resolve))');
      const screenshot = await window.webContents.capturePage();
      await writeFile(join(profile, `shared-ui-${theme}.png`), screenshot.toPNG(), { mode: 0o600 });
    }
    process.stdout.write('WECHAT_PROBE_SMOKE_OK\n');
    quitting = true; await gateway.stop(); await probe.stop(); app.quit();
  }
}).catch((error) => {
  if (process.argv.includes('--smoke') && /^[A-Z_]{1,80}$/.test(error?.message || ''))
    process.stderr.write(`${error.message}\n`);
  process.stderr.write('微信验证工具启动失败（未输出凭据或接口正文）。\n');
  quitting = true; app.exit(1);
});
app.on('window-all-closed', () => { if (!quitting) { quitting = true; (async () => { await gateway?.stop(); await probe?.stop(); })().finally(() => app.quit()); } });
