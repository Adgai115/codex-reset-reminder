// Electron main process: single instance, tray + manage window. The app is
// the cross-platform replacement for main-tray.ps1 / manage.ps1.
import { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage } from 'electron';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { coreRequest, coreStatus, setDesktopPresenter } from './core-host.mjs';
import { createReminderManager } from './reminder-window.mjs';
import { createScheduler } from './scheduler.mjs';
import { createCallbackListener } from './callback-listener.mjs';

const directory = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(directory, '..');
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

  app.on('second-instance', () => { showManage(); });

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
    return window;
  }

  function showManage() {
    if (!manageWindow || manageWindow.isDestroyed()) manageWindow = createManageWindow();
    else { manageWindow.show(); manageWindow.focus(); }
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
    if (mutatingOperations.has(op)) await scheduler?.reschedule();
    return result;
  });
  ipcMain.handle('core:status', (event) => {
    if (event.senderFrame?.url !== managePage) throw new Error('不允许的页面操作');
    return coreStatus();
  });

  app.whenReady().then(async () => {
    if (app.isPackaged) {
      process.env.CODEX_RESET_MONITOR_DATA_DIR = app.getPath('userData');
      process.env.CODEX_RESET_MONITOR_CONFIG_PATH = join(app.getPath('userData'), 'config.json');
    }
    scheduler = createScheduler({ coreRequest });
    reminders = createReminderManager({ coreRequest, onScheduleChanged: scheduler.reschedule });
    setDesktopPresenter(reminders.present);
    const refreshMenu = createTray();
    showManage();
    setInterval(refreshMenu, 60_000); // keep tray summary fresh
    scheduler.start();
    const { databasePath } = await import('../core/store.mjs');
    callbackListener = createCallbackListener({
      configPath: process.env.CODEX_RESET_MONITOR_CONFIG_PATH || join(projectRoot, 'config.json'),
      databasePath, coreRequest, onChanged: scheduler.reschedule,
    });
    callbackListener.start().catch((error) => console.warn(`[feishu] ${error.message}`));
  });

  app.on('before-quit', () => {
    quitting = true;
    scheduler?.stop();
    callbackListener?.stop();
    reminders?.closeAll();
  });
  app.on('window-all-closed', () => { /* stay in tray */ });
  app.on('activate', () => showManage());
}
