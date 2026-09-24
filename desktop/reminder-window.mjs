import { BrowserWindow, ipcMain, screen, shell } from 'electron';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';

const directory = dirname(fileURLToPath(import.meta.url));
const reminderPage = join(directory, '..', 'ui', 'reminder', 'index.html');
const width = 420;
const height = 292;

export function createReminderManager({ coreRequest, onScheduleChanged }) {
  const windows = new Map();

  ipcMain.handle('reminder:act', async (event, action, option) => {
    const record = windows.get(event.sender.id);
    if (!record || event.senderFrame?.url !== pathToFileURL(reminderPage).href) {
      throw new Error('提醒窗口无效');
    }
    if (action === 'open') {
      await shell.openExternal('https://chatgpt.com/codex');
    } else if (action === 'snooze') {
      if (!['1d', '3d', 'tomorrow10'].includes(option)) throw new Error('提醒时间无效');
      await coreRequest('scheduleSnooze', { cardId: record.payload.creditId, option });
      await onScheduleChanged();
    } else if (action !== 'dismiss') {
      throw new Error('未知的提醒操作');
    }
    record.window.close();
    return true;
  });

  async function present(payload) {
    const workArea = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
    const stackIndex = Math.max(0, Number(payload.stackIndex) || 0) % 3;
    const x = workArea.x + workArea.width - width - 16;
    const y = Math.max(workArea.y + 12,
      workArea.y + workArea.height - height - 16 - stackIndex * (height + 10));
    const window = new BrowserWindow({
      width, height, x, y, frame: false, resizable: false, movable: true,
      alwaysOnTop: true, skipTaskbar: true, show: false,
      webPreferences: { preload: join(directory, 'preload.cjs'), contextIsolation: true,
        nodeIntegration: false, sandbox: true },
    });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', (event) => event.preventDefault());
    const timer = setTimeout(() => { if (!window.isDestroyed()) window.close(); }, 90_000);
    const windowId = window.webContents.id;
    windows.set(windowId, { window, payload });
    window.on('closed', () => { clearTimeout(timer); windows.delete(windowId); });
    try {
      await window.loadFile(reminderPage);
      window.webContents.send('reminder:data', payload);
      window.showInactive();
    } catch (error) {
      if (!window.isDestroyed()) window.close();
      throw error;
    }
  }

  return { present, closeAll: () => {
    for (const { window } of windows.values()) if (!window.isDestroyed()) window.close();
  } };
}
