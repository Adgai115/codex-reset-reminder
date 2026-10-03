// Electron main process: single instance, tray + manage window. The app is
// the cross-platform replacement for main-tray.ps1 / manage.ps1.
import { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, dialog, shell, powerMonitor, safeStorage } from 'electron';
import { existsSync, mkdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { coreRequest, coreStatus, setDesktopPresenter, setAccountProvider, setWechatTransport } from './core-host.mjs';
import { requestPushplus } from '../core/pushplus-http.mjs';
import { invokeWechatLocalClient } from '../core/wechat-local-client.mjs';
import { readWechatToken } from './channel-credentials.mjs';
import { createAccountSessions } from './account-sessions.mjs';
import { createReminderManager } from './reminder-window.mjs';
import { createScheduler } from './scheduler.mjs';
import { createCallbackListener } from './callback-listener.mjs';
import { discoverCodexScript, ensureLegacyMigrationReady, initializeConfig,
  offerLegacyMigration } from './first-run.mjs';
import { readSettings, saveSettings, connectFeishu } from './settings.mjs';
import { setAutoStart } from './autostart.mjs';
import { diagnoseLocal, probeCodex } from './diagnostics.mjs';
import { checkForUpdates, releasePageFor } from './update-check.mjs';
import { createWindowsUpdater } from './update-install.mjs';
import { repairCodexPath } from './cli-repair.mjs';

const directory = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(directory, '..');
const require = createRequire(import.meta.url);
const localClientHelper = process.argv.includes('--wechat-local-client-helper');
if (!localClientHelper && process.env.CODEX_RESET_MONITOR_USER_DATA_DIR) {
  mkdirSync(process.env.CODEX_RESET_MONITOR_USER_DATA_DIR, { recursive: true });
  app.setPath('userData', process.env.CODEX_RESET_MONITOR_USER_DATA_DIR);
}
const gotLock = localClientHelper || app.requestSingleInstanceLock();
if (localClientHelper) {
  await import('./wechat-local-client-main.mjs');
} else if (!gotLock) {
  app.quit();
} else {
  let tray = null;
  let manageWindow = null;
  let quitting = false;
  let scheduler = null;
  let reminders = null;
  let callbackListener = null;
  let setupWindow = null;
  let settingsWindow = null;
  let trayRefreshTimer = null;
  let availableUpdate = null;
  let windowsUpdater = null;
  let refreshTray = null;
  let stateTimer = null;
  let settingsDraft = { dirty: false, working: false };
  let closingSettings = false;
  let choosingClose = false;
  let accountSessions = null;
  let accountTimer = null;
  let checkingCurrent = false;
  let lastCurrentScope = null;
  let sessionsClosed = false;
  let testingWechat = false;
  let preferencesWorking = false;
  let lastWechatTestAt = 0;
  let closingSessions = false;

  function stateChanged() {
    if (quitting) return;
    clearTimeout(stateTimer);
    stateTimer = setTimeout(() => {
      if (manageWindow && !manageWindow.isDestroyed()) manageWindow.webContents.send('state:changed');
      if (settingsWindow && !settingsWindow.isDestroyed()) settingsWindow.webContents.send('state:changed');
      refreshTray?.();
    }, 120);
  }

  async function discardSettings() {
    if (settingsDraft.working || preferencesWorking || testingWechat) {
      settingsWindow?.show(); settingsWindow?.focus();
      await dialog.showMessageBox(settingsWindow, { type: 'info', message: '正在处理操作，请稍候再关闭。' });
      return false;
    }
    if (!settingsDraft.dirty) return true;
    const { response } = await dialog.showMessageBox(settingsWindow, { type: 'question', noLink: true,
      message: '设置尚未保存', detail: '关闭将放弃尚未保存的修改。',
      buttons: ['继续编辑', '放弃修改'], defaultId: 0, cancelId: 0 });
    return response === 1;
  }

  async function requestQuit() {
    if (await discardSettings()) { quitting = true; app.quit(); }
  }

  app.on('second-instance', () => {
    if (setupWindow && !setupWindow.isDestroyed()) { setupWindow.show(); setupWindow.focus(); }
    else if (scheduler) showManage();
  });

  function createManageWindow() {
    const window = new BrowserWindow({
      width: 1180, height: 680, minWidth: 800, minHeight: 480, show: false,
      title: 'Codex 重置卡提醒',
      icon: join(projectRoot, 'assets', 'app-icon.png'),
      autoHideMenuBar: true,
      webPreferences: {
        preload: join(directory, 'preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    window.loadFile(join(projectRoot, 'ui', 'manage', 'index.html'));
    window.once('ready-to-show', () => window.show());
    window.on('close', async (event) => {
      if (quitting) return;
      event.preventDefault();
      if (choosingClose) return;
      choosingClose = true;
      try {
        const { response } = await dialog.showMessageBox(window, { type: 'question', noLink: true,
          message: '关闭窗口后，是否继续提醒？',
          detail: '收起后继续提醒；退出后停止提醒。',
          buttons: ['收起到托盘', '退出应用', '取消'], defaultId: 0, cancelId: 2 });
        if (response === 0) { settingsWindow?.hide(); window.hide(); }
        else if (response === 1) await requestQuit();
      } finally { choosingClose = false; }
    });
    window.on('minimize', (event) => { event.preventDefault(); window.hide(); });
    return window;
  }

  function showManage() {
    if (!manageWindow || manageWindow.isDestroyed()) manageWindow = createManageWindow();
    else { if (manageWindow.isMinimized()) manageWindow.restore(); manageWindow.show(); manageWindow.focus(); }
    if (settingsWindow && !settingsWindow.isDestroyed()) settingsWindow.show();
    stateChanged();
  }

  function showSetup() {
    if (setupWindow && !setupWindow.isDestroyed()) { setupWindow.show(); setupWindow.focus(); return; }
    setupWindow = new BrowserWindow({
      width: 620, height: 560, minWidth: 560, minHeight: 480, show: false,
      title: 'Codex 重置卡提醒 · 安装与连接',
      icon: join(projectRoot, 'assets', 'app-icon.png'),
      autoHideMenuBar: true,
      webPreferences: { preload: join(directory, 'preload.cjs'), contextIsolation: true,
        nodeIntegration: false, sandbox: true },
    });
    setupWindow.loadFile(join(projectRoot, 'ui', 'setup', 'index.html'));
    setupWindow.once('ready-to-show', () => setupWindow.show());
    setupWindow.on('closed', () => { setupWindow = null; if (!scheduler) app.quit(); });
  }

  function showSettings(tab = 'reminders') {
    if (settingsWindow && !settingsWindow.isDestroyed()) {
      settingsWindow.webContents.send('settings:tab', tab);
      settingsWindow.show(); settingsWindow.focus(); return;
    }
    settingsWindow = new BrowserWindow({
      width: 660, height: 700, minWidth: 560, minHeight: 500, show: false, title: 'Codex 重置卡提醒 · 设置',
      parent: manageWindow, autoHideMenuBar: true,
      icon: join(projectRoot, 'assets', 'app-icon.png'),
      webPreferences: { preload: join(directory, 'preload.cjs'), contextIsolation: true,
        nodeIntegration: false, sandbox: true },
    });
    settingsWindow.loadFile(join(projectRoot, 'ui', 'settings', 'index.html'), { hash: tab });
    settingsWindow.once('ready-to-show', () => settingsWindow.show());
    let confirming = false;
    settingsWindow.on('close', async (event) => {
      if (quitting || closingSettings || (!settingsDraft.dirty && !settingsDraft.working && !preferencesWorking && !testingWechat)) return;
      event.preventDefault();
      if (confirming) return;
      confirming = true;
      try {
        if (await discardSettings()) { closingSettings = true; settingsWindow.close(); }
      } finally { confirming = false; }
    });
    settingsWindow.on('closed', () => {
      settingsWindow = null; settingsDraft = { dirty: false, working: false }; closingSettings = false;
    });
  }

  function createTray() {
    const icon = nativeImage.createFromPath(join(projectRoot, 'assets', 'app-icon.png')).resize({ width: 16, height: 16 });
    tray = new Tray(icon);
    tray.setToolTip('Codex 重置卡提醒');
    tray.on('click', () => showManage());
    const refreshMenu = async () => {
      let summary = '状态不可用';
      let detail = summary;
      let pendingCount = 0;
      try {
        const snapshot = await coreRequest('allAccountsSnapshot');
        const cards = snapshot.cards.filter((card) => card.status === 'available' && card.expiresAt > Date.now() / 1000);
        const checkedAt = Math.max(0, ...snapshot.accounts.map((account) => account.latest?.checkedAt || 0));
        pendingCount = cards.filter((card) => card.pendingReminder).length;
        reminders?.reconcile(snapshot);
        const count = cards.length;
        const next = cards.reduce((earliest, card) => !earliest || card.expiresAt < earliest.expiresAt ? card : earliest, null);
        summary = `${count} 张可用`;
        detail = `${summary}\n最近到期：${next ? new Date(next.expiresAt * 1000).toLocaleString('zh-CN', { hour12: false }) : '无'}\n最近同步：${checkedAt ? new Date(checkedAt * 1000).toLocaleString('zh-CN', { hour12: false }) : '从未'}`;
      } catch (error) { summary = '读取失败'; detail = error.message; }
      if (quitting || tray.isDestroyed()) return;
      tray.setToolTip(`Codex 重置卡提醒\n${detail}`);
      tray.setContextMenu(Menu.buildFromTemplate([
        { label: '打开卡片管理', click: () => showManage() },
        { label: '设置', click: () => showSettings() },
        ...(pendingCount ? [{ label: `已提醒 ${pendingCount} 张`, click: () => {
          openPendingReminders().catch(() => showManage());
        } }] : []),
        { label: summary, enabled: false },
        { type: 'separator' },
        { label: '退出应用（停止提醒）', click: () => requestQuit() },
      ]));
    };
    refreshMenu();
    return refreshMenu;
  }

  const managePage = pathToFileURL(join(projectRoot, 'ui', 'manage', 'index.html')).href;
  const settingsPage = pathToFileURL(join(projectRoot, 'ui', 'settings', 'index.html')).href;
  const isSettingsPage = (event) => event.senderFrame?.url?.split('#')[0] === settingsPage
    && settingsWindow && !settingsWindow.isDestroyed() && event.sender === settingsWindow.webContents;
  const settingsOperations = new Set(['manageSnapshot', 'checkAccount', 'confirmLegacyBinding',
    'selectAccount', 'updateAccount', 'syncCards']);
  async function openPendingReminders(cardId) {
    try {
      const payload = await coreRequest('pendingReminders', { cardId, all: true });
      await reminders.present(payload);
      return payload.cards.length;
    } finally { stateChanged(); }
  }
  ipcMain.handle('reminders:openPending', (event, cardId) => {
    if (event.senderFrame?.url !== managePage || (cardId !== undefined && typeof cardId !== 'string'))
      throw new Error('不允许的页面操作');
    return openPendingReminders(cardId);
  });
  const allowedOperations = new Set(['manageSnapshot', 'listCards', 'getCard', 'latestSync', 'latestCompleteSync',
    'snooze',
    'scheduleSnooze', 'clearSnooze', 'syncCards', 'retryFailedChannels',
    'checkAccount', 'confirmLegacyBinding', 'selectAccount', 'updateAccount']);
  const mutatingOperations = new Set(['scheduleSnooze', 'clearSnooze', 'selectAccount', 'updateAccount']);
  ipcMain.handle('core', async (event, op, args) => {
    if (!(event.senderFrame?.url === managePage && allowedOperations.has(op))
      && !(isSettingsPage(event) && settingsOperations.has(op))) {
      throw new Error('不允许的页面操作');
    }
    if (op === 'syncCards' && scheduler) {
      const snapshot = await coreRequest('manageSnapshot');
      return scheduler.sync('manual', args?.scopeId || snapshot.account.scopeId);
    }
    if (op === 'retryFailedChannels' && scheduler) return scheduler.retry(args);
    const result = await coreRequest(op, args);
    if (op === 'checkAccount' || op === 'confirmLegacyBinding') {
      stateChanged();
      if (result.state !== 'verified') return result;
      let syncResult = null;
      let syncError = null;
      try { syncResult = await scheduler?.sync('account-confirmed', result.scopeId) || null; }
      catch (error) { syncError = error.message; }
      // A check may switch accounts while an earlier sync is still running.
      // Once that request settles, immediately fetch the newly active account.
      if (scheduler && (syncError || syncResult?.accountScopeId !== result.scopeId)) {
        try { syncResult = await scheduler.sync('account-switched', result.scopeId); syncError = null; }
        catch (error) { syncError = error.message; }
      }
      scheduler?.check('account-confirmed');
      return { ...result, syncResult, syncError };
    }
    if (op === 'manageSnapshot') return { ...result, ...scheduler?.syncState(result.account.scopeId),
      syncing: result.syncing || scheduler?.isSyncingScope(result.account.scopeId) === true,
      nextSyncAt: result.account.nextSyncAt || scheduler?.syncState().nextSyncAt,
      recovering: result.account.recovering, login: accountSessions?.status(),
      retrying: scheduler?.isRetrying() === true };
    if (mutatingOperations.has(op)) {
      stateChanged();
      if (op !== 'selectAccount') scheduler?.check('card-change');
    }
    return result;
  });
  ipcMain.handle('accounts:login', async (event, scopeId) => {
    if ((event.senderFrame?.url !== managePage && !isSettingsPage(event))
      || (scopeId !== undefined && typeof scopeId !== 'string'))
      throw new Error('不允许的账号操作');
    if (scopeId) await coreRequest('manageSnapshot', { scopeId });
    const config = JSON.parse(await readFile(currentConfigPath(), 'utf8'));
    return accountSessions.startLogin({ script: config.codexScript, expectedScopeId: scopeId || null,
      onComplete: async (args) => {
        const result = await coreRequest('completeAccountLogin', args);
        stateChanged();
        await scheduler?.sync('account-login', result.scopeId).catch(() => {});
      } });
  });
  ipcMain.handle('accounts:cancelLogin', (event) => {
    if (event.senderFrame?.url !== managePage && !isSettingsPage(event)) throw new Error('不允许的账号操作');
    return accountSessions.cancelLogin();
  });
  ipcMain.handle('app:quit', (event) => {
    if (event.senderFrame?.url !== managePage) throw new Error('不允许的页面操作');
    return requestQuit();
  });
  ipcMain.handle('core:status', (event) => {
    if (event.senderFrame?.url !== managePage) throw new Error('不允许的页面操作');
    return coreStatus();
  });
  const checkSettingsPage = (event) => {
    if (!isSettingsPage(event)) {
      throw new Error('不允许的设置操作');
    }
  };
  const currentConfigPath = () => process.env.CODEX_RESET_MONITOR_CONFIG_PATH || join(projectRoot, 'config.json');
  ipcMain.handle('settings:open', (event, tab = 'reminders') => {
    if (event.senderFrame?.url !== managePage) throw new Error('不允许的页面操作');
    if (!['reminders', 'accounts'].includes(tab)) throw new Error('不允许的设置页面');
    showSettings(tab);
  });
  ipcMain.handle('settings:viewAccount', async (event, scopeId) => {
    checkSettingsPage(event);
    if (typeof scopeId !== 'string' || !scopeId) throw new Error('请选择账号');
    await coreRequest('selectAccount', { scopeId });
    stateChanged();
    showManage(); settingsWindow.hide(); manageWindow.focus();
    scheduler?.sync('account-selected', scopeId).catch(() => {});
    return { scopeId };
  });
  ipcMain.handle('settings:read', async (event) => {
    checkSettingsPage(event);
    return { ...await readSettings(currentConfigPath()), version: app.getVersion() };
  });
  ipcMain.handle('settings:listenerStatus', (event) => {
    checkSettingsPage(event);
    return callbackListener?.status() || { state: 'starting', lastError: null, lastEventAt: null };
  });
  ipcMain.handle('settings:diagnoseLocal', (event) => {
    checkSettingsPage(event);
    return diagnoseLocal(currentConfigPath(), callbackListener?.status());
  });
  ipcMain.handle('settings:probeCodex', async (event) => {
    checkSettingsPage(event);
    const config = JSON.parse(await readFile(currentConfigPath(), 'utf8'));
    return probeCodex(config.codexScript);
  });
  ipcMain.handle('settings:repairCodex', async (event) => {
    checkSettingsPage(event);
    const selection = await dialog.showOpenDialog(settingsWindow, { title: '重新选择已登录的 Codex CLI',
      properties: ['openFile'], filters: process.platform === 'win32'
        ? [{ name: 'Codex CLI', extensions: ['js', 'exe'] }, { name: '所有文件', extensions: ['*'] }] : [] });
    if (selection.canceled) return null;
    const result = await repairCodexPath(currentConfigPath(), selection.filePaths[0]);
    scheduler?.sync('connection-repaired').catch((error) => console.warn(`[scheduler] ${error.message}`));
    stateChanged();
    return result;
  });
  ipcMain.handle('settings:checkUpdates', async (event) => {
    checkSettingsPage(event);
    availableUpdate = null;
    let result;
    if (windowsUpdater) {
      try { result = await windowsUpdater.check(); }
      catch (error) {
        const fallback = await checkForUpdates(app.getVersion());
        result = { ...fallback, canInstall: false,
          message: fallback.state === 'available'
            ? `发现 ${fallback.latestVersion}；应用内更新不可用：${error.message}` : fallback.message };
      }
    } else result = await checkForUpdates(app.getVersion());
    availableUpdate = result.state === 'available' ? result.latestVersion : null;
    return result;
  });
  ipcMain.handle('settings:updateStatus', (event) => {
    checkSettingsPage(event);
    return windowsUpdater?.status() || { phase: 'manual', message: '' };
  });
  ipcMain.handle('settings:downloadUpdate', async (event) => {
    checkSettingsPage(event);
    if (!windowsUpdater || !availableUpdate) throw new Error('请先检查新版本');
    return windowsUpdater.download(availableUpdate.replace(/^v/, ''));
  });
  ipcMain.handle('settings:installUpdate', async (event) => {
    checkSettingsPage(event);
    if (!windowsUpdater || !availableUpdate) throw new Error('请先下载新版本');
    if (windowsUpdater.status().phase !== 'ready') throw new Error('请先完成下载和校验');
    const { response } = await dialog.showMessageBox(settingsWindow, { type: 'question', noLink: true,
      message: `升级到 ${availableUpdate}？`,
      detail: '应用会关闭并在原位置升级，完成后自动重新打开。配置和卡片数据保留。',
      buttons: ['立即升级', '稍后'], defaultId: 0, cancelId: 1 });
    if (response !== 0) return { canceled: true };
    if (!await discardSettings()) return { canceled: true };
    windowsUpdater.install(availableUpdate.replace(/^v/, ''));
    quitting = true;
    return { installing: true };
  });
  ipcMain.handle('settings:openUpdate', async (event) => {
    checkSettingsPage(event);
    if (!availableUpdate) throw new Error('请先检查新版本');
    await shell.openExternal(releasePageFor(availableUpdate));
  });
  ipcMain.handle('settings:save', async (event, input) => {
    checkSettingsPage(event);
    if (preferencesWorking || testingWechat) throw new Error('设置操作正在进行，请稍后重试');
    preferencesWorking = true;
    try {
      const settings = await saveSettings(currentConfigPath(), input, { crypto: safeStorage });
      if (settings.feishuEnabled) callbackListener?.start().catch((error) => console.warn(`[feishu] ${error.message}`));
      else callbackListener?.stop();
      scheduler?.check('settings-change');
      settingsDraft = { dirty: false, working: false };
      stateChanged();
      return settings;
    } finally { preferencesWorking = false; }
  });
  ipcMain.handle('settings:draft', (event, state) => {
    checkSettingsPage(event);
    settingsDraft = { dirty: state?.dirty === true, working: state?.working === true };
  });
  ipcMain.handle('settings:close', (event) => {
    checkSettingsPage(event);
    settingsWindow.close();
  });
  ipcMain.handle('feishu:connect', async (event, input) => {
    checkSettingsPage(event);
    if (preferencesWorking || testingWechat) throw new Error('设置操作正在进行，请稍后重试');
    preferencesWorking = true;
    try {
      const settings = await connectFeishu(currentConfigPath(), input);
      callbackListener?.refresh().catch((error) => console.warn(`[feishu] ${error.message}`));
      scheduler?.check('feishu-connected');
      return settings;
    } finally { preferencesWorking = false; }
  });
  ipcMain.handle('settings:testDesktop', async (event) => {
    checkSettingsPage(event);
    await reminders.present({ cardName: '【测试】演示重置卡', creditId: 'simulation-card',
      accountDisplay: '演示账号',
      expiresAt: Math.floor(Date.now() / 1000) + 7 * 86400,
      expiresLocal: new Date(Date.now() + 7 * 86400000).toLocaleString('zh-CN', { hour12: false }),
      days: 7, currentAvailableCount: null, stackIndex: 0, simulated: true });
    return true;
  });
  ipcMain.handle('settings:openPushplusSetup', async (event) => {
    checkSettingsPage(event);
    await shell.openExternal('https://www.pushplus.plus/');
  });
  ipcMain.handle('settings:browseWechatClient', async (event) => {
    checkSettingsPage(event);
    if (preferencesWorking || testingWechat) throw new Error('设置操作正在进行，请稍后重试');
    preferencesWorking = true;
    try {
      const result = await dialog.showOpenDialog(settingsWindow, { title: '选择微信网关加密调用文件',
        properties: ['openFile'], filters: [{ name: '微信网关调用文件', extensions: ['bin'] }] });
      return result.canceled ? null : result.filePaths[0];
    } finally { preferencesWorking = false; }
  });
  ipcMain.handle('settings:testWechat', async (event) => {
    checkSettingsPage(event);
    if (testingWechat || preferencesWorking) throw new Error('设置操作正在进行，请稍后重试');
    if (Date.now() - lastWechatTestAt < 60_000) throw new Error('请稍后再测试微信，避免频繁发送');
    testingWechat = true;
    try {
      const config = JSON.parse(await readFile(currentConfigPath(), 'utf8'));
      const local = config.wechat?.provider === 'local-gateway';
      if (!local && config.wechat?.provider !== 'pushplus') throw new Error('请先保存微信配置');
      const { response } = await dialog.showMessageBox(settingsWindow, { type: 'question', noLink: true,
        message: '发送一条微信测试消息？', detail: local ? '将通过本机微信网关发送，不会使用重置卡。' : '将通过已保存的 PushPlus 配置发送，不会使用重置卡。',
        buttons: ['发送测试', '取消'], defaultId: 1, cancelId: 1 });
      if (response !== 0) return { canceled: true, message: '已取消微信测试' };
      lastWechatTestAt = Date.now();
      if (local) {
        const result = await invokeWechatLocalClient({ electronPath: process.execPath,
          clientFile: config.wechat.gatewayClientFile,
          request: { id: `test-${randomUUID()}`, title: '【测试】Codex 重置卡提醒',
            text: '这是你主动发送的微信渠道测试消息。\n没有使用任何重置卡，不包含真实账号或卡片。' } });
        if (result.state !== 'accepted') throw new Error(result.state === 'unknown' || result.state === 'pending'
          ? '微信发送结果未知，已停止补发，请到手机核对。'
          : '微信测试未完成发送，请检查网关、调用文件及来源权限。');
        return { confirmation: 'accepted', message: '微信已接受测试请求，请到手机确认接收' };
      }
      const token = await readWechatToken(currentConfigPath(), config, { crypto: safeStorage });
      const result = await requestPushplus({ title: '【测试】Codex 重置卡提醒', template: 'txt', channel: 'wechat',
        content: '这是你主动发送的微信渠道测试消息。\n没有使用任何重置卡。\n后续到期提醒会包含所属账号、卡片与到期时间。' }, { token });
      return { confirmation: result.confirmation, message: '测试请求已提交，请到微信确认接收' };
    } finally { testingWechat = false; }
  });

  const setupPage = pathToFileURL(join(projectRoot, 'ui', 'setup', 'index.html')).href;
  const checkSetupPage = (event) => {
    if (event.senderFrame?.url !== setupPage || !setupWindow || setupWindow.isDestroyed()) {
      throw new Error('不允许的安装操作');
    }
  };
  ipcMain.handle('setup:discover', (event) => {
    checkSetupPage(event);
    return { codexScript: discoverCodexScript() };
  });
  ipcMain.handle('setup:probeCodex', (event, codexScript) => {
    checkSetupPage(event);
    return probeCodex(String(codexScript || '').trim());
  });
  ipcMain.handle('setup:browse', async (event) => {
    checkSetupPage(event);
    const result = await dialog.showOpenDialog(setupWindow, {
      title: '选择 Codex CLI', properties: ['openFile'],
      filters: process.platform === 'win32'
        ? [{ name: 'Codex CLI', extensions: ['js', 'exe'] }, { name: '所有文件', extensions: ['*'] }]
        : [],
    });
    return result.canceled ? null : result.filePaths[0];
  });
  ipcMain.handle('setup:save', async (event, options) => {
    checkSetupPage(event);
    if (!app.isPackaged) throw new Error('开发版请使用项目目录的 config.json');
    const configPath = process.env.CODEX_RESET_MONITOR_CONFIG_PATH;
    const connection = await initializeConfig({ codexScript: options?.codexScript, configPath,
      examplePath: join(projectRoot, 'config.example.json') });
    try { await setAutoStart(options?.autoStartEnabled === true); }
    catch (error) {
      await dialog.showMessageBox(setupWindow, { type: 'warning', message: 'Codex 已连接，但登录自启设置失败',
        detail: `${error.message}\n可以先使用应用，再到“设置 → 提醒”中重新启用。` });
    }
    setTimeout(() => {
      startRuntime().then(() => { if (setupWindow && !setupWindow.isDestroyed()) setupWindow.close(); })
        .catch((error) => dialog.showErrorBox('启动失败', error.message));
    }, connection.complete ? 100 : 2000);
    return connection;
  });

  async function startRuntime() {
    if (scheduler) return;
    accountSessions = createAccountSessions({ directory: process.env.CODEX_RESET_MONITOR_DATA_DIR
      || join(projectRoot, '.state'), crypto: safeStorage, openLogin: (url) => shell.openExternal(url), onChanged: stateChanged });
    setAccountProvider((action, args) => {
      if (action === 'has') return accountSessions.has(args.scopeId);
      if (['request', 'capture', 'loginRequest'].includes(action)) return accountSessions[action](args);
      throw new Error('不允许的账号会话操作');
    });
    setWechatTransport(async (config, payload) => {
      if (config.wechat?.provider === 'local-gateway')
        return invokeWechatLocalClient({ electronPath: process.execPath, clientFile: config.wechat.gatewayClientFile, request: payload });
      const token = await readWechatToken(currentConfigPath(), config, { crypto: safeStorage });
      return requestPushplus(payload, { token });
    });
    scheduler = createScheduler({ coreRequest, powerMonitor, onResult: () => stateChanged(),
      onChanged: stateChanged });
    const onChanged = () => { stateChanged(); scheduler.reschedule(); };
    reminders = createReminderManager({ coreRequest, onScheduleChanged: onChanged });
    setDesktopPresenter(reminders.present);
    refreshTray = createTray();
    const background = process.argv.includes('--background') || (process.platform === 'darwin'
      && app.getLoginItemSettings().wasOpenedAtLogin);
    if (!background || setupWindow) showManage();
    trayRefreshTimer = setInterval(refreshTray, 60_000);
    scheduler.start();
    // CLI 换号后自动发现新账号；已保存账号的后台工作继续运行。
    accountTimer = setInterval(async () => {
      if (checkingCurrent || quitting) return;
      checkingCurrent = true;
      try {
        const status = await coreRequest('checkAccount');
        if (status.state === 'verified' && status.scopeId !== lastCurrentScope) {
          lastCurrentScope = status.scopeId;
          await scheduler.sync('cli-account-changed', status.scopeId);
        }
        stateChanged();
      } catch { /* 后台同步有独立重试；不覆盖其他账号状态。 */ }
      finally { checkingCurrent = false; }
    }, 30_000);
    const { databasePath } = await import('../core/store.mjs');
    callbackListener = createCallbackListener({
      configPath: process.env.CODEX_RESET_MONITOR_CONFIG_PATH || join(projectRoot, 'config.json'),
      databasePath, coreRequest, onChanged,
    });
    callbackListener.start().catch((error) => console.warn(`[feishu] ${error.message}`));
  }

  app.whenReady().then(async () => {
    if (process.platform === 'win32' && app.isPackaged) {
      const { autoUpdater } = require('electron-updater');
      windowsUpdater = createWindowsUpdater({ updater: autoUpdater, currentVersion: app.getVersion(),
        emit: (status) => {
          if (settingsWindow && !settingsWindow.isDestroyed())
            settingsWindow.webContents.send('update:status', status);
        } });
    }
    if (app.isPackaged) {
      const userData = app.getPath('userData');
      process.env.CODEX_RESET_MONITOR_DATA_DIR = userData;
      process.env.CODEX_RESET_MONITOR_CONFIG_PATH = join(userData, 'config.json');
      process.env.CODEX_RESET_MONITOR_NODE_PATH = join(process.resourcesPath, 'vendor-node',
        process.platform === 'win32' ? 'node.exe' : 'node');
      let migrated = false;
      if (!existsSync(process.env.CODEX_RESET_MONITOR_CONFIG_PATH)
        && !existsSync(join(userData, 'migration.json'))
        && process.env.CODEX_RESET_MONITOR_SKIP_MIGRATION !== '1') {
        try {
          const migration = await offerLegacyMigration(userData);
          if (migration === 'declined') { app.quit(); return; }
          migrated = migration === 'migrated';
        }
        catch (error) {
          await dialog.showMessageBox({ type: 'error', message: `旧版迁移失败：${error.message}` });
          app.quit();
          return;
        }
      }
      try {
        if (!await ensureLegacyMigrationReady(userData)) { app.quit(); return; }
        if (migrated) await setAutoStart(true);
      } catch (error) {
        await dialog.showMessageBox({ type: 'error', message: `旧版迁移未完成：${error.message}` });
        app.quit();
        return;
      }
      if (!existsSync(process.env.CODEX_RESET_MONITOR_CONFIG_PATH)) { showSetup(); return; }
    }
    await startRuntime();
  }).catch((error) => { dialog.showErrorBox('启动失败', error.message); app.quit(); });

  app.on('before-quit', (event) => {
    quitting = true;
    scheduler?.stop();
    callbackListener?.stop();
    reminders?.closeAll();
    clearInterval(trayRefreshTimer);
    clearTimeout(stateTimer);
    clearInterval(accountTimer);
    if (accountSessions && !sessionsClosed) {
      event.preventDefault();
      if (!closingSessions) {
        closingSessions = true;
        accountSessions.close().catch(() => {}).finally(() => {
          sessionsClosed = true; console.info('[accounts] 会话已关闭'); app.quit();
        });
      }
    }
  });
  app.on('window-all-closed', () => { /* stay in tray */ });
  app.on('activate', () => {
    if (setupWindow && !setupWindow.isDestroyed()) { setupWindow.show(); setupWindow.focus(); }
    else if (scheduler) showManage();
  });
}
