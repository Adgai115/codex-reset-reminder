// Electron main process: single instance, tray + manage window. The app is
// the cross-platform replacement for main-tray.ps1 / manage.ps1.
import { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, shell } from 'electron';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { coreRequest, coreStatus } from './core-host.mjs';

const directory = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(directory, '..');
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  let tray = null;
  let manageWindow = null;
  let quitting = false;

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

  ipcMain.handle('core', (_event, op, args) => coreRequest(op, args));
  ipcMain.handle('core:status', () => coreStatus());
  ipcMain.handle('manage:show', () => { showManage(); });
  ipcMain.handle('shell:openExternal', (_event, url) => shell.openExternal(url));

  app.whenReady().then(() => {
    const refreshMenu = createTray();
    showManage();
    setInterval(refreshMenu, 60_000); // keep tray summary fresh
  });

  app.on('before-quit', () => { quitting = true; });
  app.on('window-all-closed', () => { /* stay in tray */ });
  app.on('activate', () => showManage());
}
