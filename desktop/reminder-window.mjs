import { BrowserWindow, ipcMain, screen, shell } from 'electron';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';
import { getSnoozeOptions } from '../core/later.mjs';

const directory = dirname(fileURLToPath(import.meta.url));
const reminderPage = join(directory, '..', 'ui', 'reminder', 'index.html');
const width = 420;
const height = 310;

export function createReminderManager({ coreRequest, onScheduleChanged }) {
  const windows = new Map();

  ipcMain.handle('reminder:act', async (event, action, option) => {
    const record = windows.get(event.sender.id);
    if (!record || event.senderFrame?.url !== pathToFileURL(reminderPage).href) {
      throw new Error('提醒窗口无效');
    }
    if (record.busy) return false;
    record.busy = true;
    try {
    if (action === 'open') {
      await shell.openExternal('https://chatgpt.com/codex');
    } else if (action === 'snooze') {
      if (!['1d', '3d', 'tomorrow10'].includes(option)) throw new Error('提醒时间无效');
      if (!record.payload.simulated) {
        await coreRequest('scheduleSnooze', { cardId: record.payload.creditId, option });
        await onScheduleChanged();
      }
    } else if (action !== 'dismiss') {
      throw new Error('未知的提醒操作');
    }
    record.window.close();
    return true;
    } finally { record.busy = false; }
  });

  async function present(payload) {
    const options = getSnoozeOptions({ status: 'available', expiresAt: payload.expiresAt });
    const data = { ...payload, snoozeOptions: options };
    const existing = [...windows.values()].find((record) => record.payload.creditId === payload.creditId);
    if (existing) { existing.window.webContents.send('reminder:data', data); existing.window.showInactive(); return; }
    const workArea = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
    const slots = Math.max(1, Math.floor((workArea.height - 24) / (height + 10)));
    const occupied = new Set([...windows.values()].map((record) => record.slot));
    let stackIndex = 0;
    while (occupied.has(stackIndex)) stackIndex++;
    const x = Math.max(workArea.x + 12, workArea.x + workArea.width - width - 16 - Math.floor(stackIndex / slots) * (width + 10));
    const y = Math.max(workArea.y + 12,
      workArea.y + workArea.height - height - 16 - (stackIndex % slots) * (height + 10));
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
    windows.set(windowId, { window, payload, slot: stackIndex, busy: false });
    window.on('closed', () => { clearTimeout(timer); windows.delete(windowId); });
    try {
      await window.loadFile(reminderPage);
      window.webContents.send('reminder:data', data);
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
