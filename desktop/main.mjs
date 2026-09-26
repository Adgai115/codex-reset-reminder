// Electron main process: single instance, tray + manage window. The app is
// the cross-platform replacement for main-tray.ps1 / manage.ps1.
import { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, dialog } from 'electron';
import { existsSync, mkdirSync } from 'node:fs';
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

  app.on('second-instance', () => {
    if (setupWindow && !setupWindow.isDestroyed()) { setupWindow.show(); setupWindow.focus(); }
    else if (scheduler) showManage();
  });

  function createManageWindow() {
    const window = new BrowserWindow({
      width: 860, height: 560, show: false,
      title: 'Codex 重置卡提醒',
      icon: join(projectRoot, 'assets', 'app-icon.png'),
      autoHideMenuBar: true,
      webPreferences: {
        preload: join(directory, 'preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    window.loadFile(join(projectRoot, 'ui', 'manage', 'index.html'));
    window.once('ready-to-show', () => window.show());
    window.on('close', (event) => {
      if (!quitting) { event.preventDefault(); window.hide(); } // close hides to tray
    });
    window.on('minimize', (event) => { event.preventDefault(); window.hide(); });
    return window;
  }

  function showManage() {
    if (!manageWindow || manageWindow.isDestroyed()) manageWindow = createManageWindow();
    else { manageWindow.show(); manageWindow.focus(); }
  }

  function showSetup() {
    if (setupWindow && !setupWindow.isDestroyed()) { setupWindow.show(); setupWindow.focus(); return; }
    setupWindow = new BrowserWindow({
      width: 580, height: 390, show: false, resizable: false,
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
      width: 660, height: 700, show: false, title: 'Codex 重置卡提醒 · 提醒设置',
      parent: manageWindow, autoHideMenuBar: true,
      icon: join(projectRoot, 'assets', 'app-icon.png'),
      webPreferences: { preload: join(directory, 'preload.cjs'), contextIsolation: true,
        nodeIntegration: false, sandbox: true },
    });
    settingsWindow.loadFile(join(projectRoot, 'ui', 'settings', 'index.html'));
    settingsWindow.once('ready-to-show', () => settingsWindow.show());
    settingsWindow.on('closed', () => { settingsWindow = null; });
  }

  function createTray() {
    const icon = nativeImage.createFromPath(join(projectRoot, 'assets', 'app-icon.png')).resize({ width: 16, height: 16 });
    tray = new Tray(icon);
    tray.setToolTip('Codex 重置卡提醒');
    tray.on('click', () => showManage());
    const refreshMenu = async () => {
      let summary = '状态不可用';
      try {
        const cards = await coreRequest('listCards');
        const latest = await coreRequest('latestSync');
        const count = cards.length;
        const next = cards[0];
        summary = `${count} 张可用 · 最近到期：${next ? new Date(next.expiresAt * 1000).toLocaleString('zh-CN', { hour12: false }) : '无'} · 上次核对：${latest ? new Date(latest.checkedAt * 1000).toLocaleString('zh-CN', { hour12: false }) : '从未'}`;
      } catch (error) { summary = `读取失败：${error.message}`; }
      tray.setToolTip(`Codex 重置卡提醒\n${summary}`);
      tray.setContextMenu(Menu.buildFromTemplate([
        { label: '打开卡片管理', click: () => showManage() },
        { label: '提醒设置', click: () => showSettings() },
        { label: summary, enabled: false },
        { type: 'separator' },
        { label: '退出', click: () => { quitting = true; app.quit(); } },
      ]));
    };
    refreshMenu();
    return refreshMenu;
  }

  const managePage = pathToFileURL(join(projectRoot, 'ui', 'manage', 'index.html')).href;
  const allowedOperations = new Set(['listCards', 'getCard', 'latestSync', 'latestCompleteSync',
    'snooze', 'addManualCard', 'updateManualCard', 'markManualUsed', 'reportCardUsed',
    'scheduleSnooze', 'clearSnooze', 'syncCards']);
  const mutatingOperations = new Set(['addManualCard', 'updateManualCard', 'markManualUsed',
    'reportCardUsed', 'scheduleSnooze', 'clearSnooze']);
  ipcMain.handle('core', async (event, op, args) => {
    if (event.senderFrame?.url !== managePage || !allowedOperations.has(op)) {
      throw new Error('不允许的页面操作');
    }
    if (op === 'syncCards' && scheduler) return scheduler.sync('manual');
    const result = await coreRequest(op, args);
    if (mutatingOperations.has(op)) scheduler?.check('card-change');
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
  ipcMain.handle('settings:read', (event) => {
    checkSettingsPage(event);
    return readSettings(currentConfigPath());
  });
  ipcMain.handle('settings:listenerStatus', (event) => {
    checkSettingsPage(event);
    return callbackListener?.status() || { state: 'starting', lastError: null, lastEventAt: null };
  });
  ipcMain.handle('settings:save', async (event, input) => {
    checkSettingsPage(event);
    const settings = await saveSettings(currentConfigPath(), input);
    if (settings.feishuEnabled) callbackListener?.start().catch((error) => console.warn(`[feishu] ${error.message}`));
    else callbackListener?.stop();
    scheduler?.check('settings-change');
    return settings;
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
    await setAutoStart(options?.autoStartEnabled === true);
    setTimeout(() => {
      startRuntime().then(() => { if (setupWindow && !setupWindow.isDestroyed()) setupWindow.close(); })
        .catch((error) => dialog.showErrorBox('启动失败', error.message));
    }, 100);
    return { connected: true };
  });

  async function startRuntime() {
    if (scheduler) return;
    scheduler = createScheduler({ coreRequest });
    reminders = createReminderManager({ coreRequest, onScheduleChanged: scheduler.reschedule });
    setDesktopPresenter(reminders.present);
    const refreshMenu = createTray();
    showManage();
    trayRefreshTimer = setInterval(refreshMenu, 60_000);
    scheduler.start();
    const { databasePath } = await import('../core/store.mjs');
    callbackListener = createCallbackListener({
      configPath: process.env.CODEX_RESET_MONITOR_CONFIG_PATH || join(projectRoot, 'config.json'),
      databasePath, coreRequest, onChanged: scheduler.reschedule,
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
  });
  app.on('window-all-closed', () => { /* stay in tray */ });
  app.on('activate', () => {
    if (setupWindow && !setupWindow.isDestroyed()) { setupWindow.show(); setupWindow.focus(); }
    else if (scheduler) showManage();
  });
}
