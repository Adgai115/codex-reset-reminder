// Electron main process: single instance, tray + manage window. The app is
// the cross-platform replacement for main-tray.ps1 / manage.ps1.
import { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, dialog, shell } from 'electron';
import { existsSync, mkdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { coreRequest, coreStatus, setDesktopPresenter } from './core-host.mjs';
import { createReminderManager } from './reminder-window.mjs';
import { createScheduler } from './scheduler.mjs';
import { createCallbackListener } from './callback-listener.mjs';
import { discoverCodexScript, ensureLegacyMigrationReady, initializeConfig,
  offerLegacyMigration } from './first-run.mjs';
import { readSettings, saveSettings, connectFeishu } from './settings.mjs';
import { setAutoStart } from './autostart.mjs';
import { diagnoseLocal, probeCodex } from './diagnostics.mjs';
import { checkForUpdates, releasePageFor } from './update-check.mjs';
import { repairCodexPath } from './cli-repair.mjs';

const directory = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(directory, '..');
if (process.env.CODEX_RESET_MONITOR_USER_DATA_DIR) {
  mkdirSync(process.env.CODEX_RESET_MONITOR_USER_DATA_DIR, { recursive: true });
  app.setPath('userData', process.env.CODEX_RESET_MONITOR_USER_DATA_DIR);
}
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
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
  let refreshTray = null;
  let stateTimer = null;
  let settingsDraft = { dirty: false, working: false };
  let closingSettings = false;
  let choosingClose = false;

  function stateChanged() {
    if (quitting) return;
    clearTimeout(stateTimer);
    stateTimer = setTimeout(() => {
      if (manageWindow && !manageWindow.isDestroyed()) manageWindow.webContents.send('state:changed');
      refreshTray?.();
    }, 120);
  }

  async function discardSettings() {
    if (settingsDraft.working) {
      settingsWindow?.show(); settingsWindow?.focus();
      await dialog.showMessageBox(settingsWindow, { type: 'info', message: '正在保存或连接，请稍候再关闭。' });
      return false;
    }
    if (!settingsDraft.dirty) return true;
    const { response } = await dialog.showMessageBox(settingsWindow, { type: 'question', noLink: true,
      message: '提醒设置尚未保存', detail: '关闭会放弃本次修改，已保存的提醒继续生效。',
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
      width: 1000, height: 650, minWidth: 800, minHeight: 480, show: false,
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
          detail: '收起到托盘会继续检查到期时间和飞书交互；退出应用会停止本机的全部提醒。',
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

  function showSettings() {
    if (settingsWindow && !settingsWindow.isDestroyed()) { settingsWindow.show(); settingsWindow.focus(); return; }
    settingsWindow = new BrowserWindow({
      width: 660, height: 700, minWidth: 560, minHeight: 500, show: false, title: 'Codex 重置卡提醒 · 提醒设置',
      parent: manageWindow, autoHideMenuBar: true,
      icon: join(projectRoot, 'assets', 'app-icon.png'),
      webPreferences: { preload: join(directory, 'preload.cjs'), contextIsolation: true,
        nodeIntegration: false, sandbox: true },
    });
    settingsWindow.loadFile(join(projectRoot, 'ui', 'settings', 'index.html'));
    settingsWindow.once('ready-to-show', () => settingsWindow.show());
    let confirming = false;
    settingsWindow.on('close', async (event) => {
      if (quitting || closingSettings || (!settingsDraft.dirty && !settingsDraft.working)) return;
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
      try {
        const cards = (await coreRequest('listCards')).filter((card) => card.expiresAt > Date.now() / 1000);
        const latest = await coreRequest('latestSync');
        const count = cards.length;
        const next = cards[0];
        summary = `${count} 张可用 · 最近到期：${next ? new Date(next.expiresAt * 1000).toLocaleString('zh-CN', { hour12: false }) : '无'} · 上次核对：${latest ? new Date(latest.checkedAt * 1000).toLocaleString('zh-CN', { hour12: false }) : '从未'}`;
      } catch (error) { summary = `读取失败：${error.message}`; }
      if (quitting || tray.isDestroyed()) return;
      tray.setToolTip(`Codex 重置卡提醒\n${summary}`);
      tray.setContextMenu(Menu.buildFromTemplate([
        { label: '打开卡片管理', click: () => showManage() },
        { label: '提醒设置', click: () => showSettings() },
        { label: summary, enabled: false },
        { type: 'separator' },
        { label: '退出应用（停止提醒）', click: () => requestQuit() },
      ]));
    };
    refreshMenu();
    return refreshMenu;
  }

  const managePage = pathToFileURL(join(projectRoot, 'ui', 'manage', 'index.html')).href;
  const allowedOperations = new Set(['manageSnapshot', 'listCards', 'getCard', 'latestSync', 'latestCompleteSync',
    'snooze', 'addManualCard', 'updateManualCard', 'markManualUsed', 'reportCardUsed',
    'scheduleSnooze', 'clearSnooze', 'syncCards', 'retryFailedChannels',
    'checkAccount', 'confirmLegacyBinding']);
  const mutatingOperations = new Set(['addManualCard', 'updateManualCard', 'markManualUsed',
    'reportCardUsed', 'scheduleSnooze', 'clearSnooze']);
  ipcMain.handle('core', async (event, op, args) => {
    if (event.senderFrame?.url !== managePage || !allowedOperations.has(op)) {
      throw new Error('不允许的页面操作');
    }
    if (op === 'syncCards' && scheduler) return scheduler.sync('manual');
    if (op === 'retryFailedChannels' && scheduler) return scheduler.retry(args);
    const result = await coreRequest(op, args);
    if (op === 'checkAccount' || op === 'confirmLegacyBinding') {
      stateChanged();
      if (result.state === 'verified') scheduler?.check('account-confirmed');
      return result;
    }
    if (op === 'manageSnapshot') return { ...result, syncing: scheduler?.isSyncing() === true,
      retrying: scheduler?.isRetrying() === true };
    if (mutatingOperations.has(op)) { stateChanged(); scheduler?.check('card-change'); }
    return result;
  });
  ipcMain.handle('core:status', (event) => {
    if (event.senderFrame?.url !== managePage) throw new Error('不允许的页面操作');
    return coreStatus();
  });
  const settingsPage = pathToFileURL(join(projectRoot, 'ui', 'settings', 'index.html')).href;
  const checkSettingsPage = (event) => {
    if (event.senderFrame?.url !== settingsPage || !settingsWindow || settingsWindow.isDestroyed()) {
      throw new Error('不允许的设置操作');
    }
  };
  const currentConfigPath = () => process.env.CODEX_RESET_MONITOR_CONFIG_PATH || join(projectRoot, 'config.json');
  ipcMain.handle('settings:open', (event) => {
    if (event.senderFrame?.url !== managePage) throw new Error('不允许的页面操作');
    showSettings();
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
    const result = await checkForUpdates(app.getVersion());
    availableUpdate = result.state === 'available' ? result.latestVersion : null;
    return result;
  });
  ipcMain.handle('settings:openUpdate', async (event) => {
    checkSettingsPage(event);
    if (!availableUpdate) throw new Error('请先检查新版本');
    await shell.openExternal(releasePageFor(availableUpdate));
  });
  ipcMain.handle('settings:save', async (event, input) => {
    checkSettingsPage(event);
    const settings = await saveSettings(currentConfigPath(), input);
    if (settings.feishuEnabled) callbackListener?.start().catch((error) => console.warn(`[feishu] ${error.message}`));
    else callbackListener?.stop();
    scheduler?.check('settings-change');
    settingsDraft = { dirty: false, working: false };
    stateChanged();
    return settings;
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
    const settings = await connectFeishu(currentConfigPath(), input);
    callbackListener?.refresh().catch((error) => console.warn(`[feishu] ${error.message}`));
    scheduler?.check('feishu-connected');
    return settings;
  });
  ipcMain.handle('settings:testDesktop', async (event) => {
    checkSettingsPage(event);
    await reminders.present({ cardName: '【测试】演示重置卡', creditId: 'simulation-card',
      expiresAt: Math.floor(Date.now() / 1000) + 7 * 86400,
      expiresLocal: new Date(Date.now() + 7 * 86400000).toLocaleString('zh-CN', { hour12: false }),
      days: 7, currentAvailableCount: null, stackIndex: 0, simulated: true });
    return true;
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
    await initializeConfig({ codexScript: options?.codexScript, configPath,
      examplePath: join(projectRoot, 'config.example.json') });
    try { await setAutoStart(options?.autoStartEnabled === true); }
    catch (error) {
      await dialog.showMessageBox(setupWindow, { type: 'warning', message: 'Codex 已连接，但登录自启设置失败',
        detail: `${error.message}\n可以先使用应用，再到提醒设置中重新启用。` });
    }
    setTimeout(() => {
      startRuntime().then(() => { if (setupWindow && !setupWindow.isDestroyed()) setupWindow.close(); })
        .catch((error) => dialog.showErrorBox('启动失败', error.message));
    }, 100);
    return { connected: true };
  });

  async function startRuntime() {
    if (scheduler) return;
    scheduler = createScheduler({ coreRequest, onResult: () => stateChanged(),
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
    const { databasePath } = await import('../core/store.mjs');
    callbackListener = createCallbackListener({
      configPath: process.env.CODEX_RESET_MONITOR_CONFIG_PATH || join(projectRoot, 'config.json'),
      databasePath, coreRequest, onChanged,
    });
    callbackListener.start().catch((error) => console.warn(`[feishu] ${error.message}`));
  }

  app.whenReady().then(async () => {
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

  app.on('before-quit', () => {
    quitting = true;
    scheduler?.stop();
    callbackListener?.stop();
    reminders?.closeAll();
    clearInterval(trayRefreshTimer);
    clearTimeout(stateTimer);
  });
  app.on('window-all-closed', () => { /* stay in tray */ });
  app.on('activate', () => {
    if (setupWindow && !setupWindow.isDestroyed()) { setupWindow.show(); setupWindow.focus(); }
    else if (scheduler) showManage();
  });
}
