import { BrowserWindow, dialog, ipcMain, screen } from 'electron';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { getSnoozeOptions } from '../core/later.mjs';
import { mergeReminderItems, reminderStillActive } from './reminder-items.mjs';
import { resetFailureResult } from './error-protocol.mjs';

const reminderPage = join(import.meta.dirname, '..', 'ui', 'reminder', 'index.html');

export function createReminderManager({ coreRequest, onScheduleChanged }) {
  // 正式提醒共用一个窗口；演示单独隔离，永不写入正式发送或延期记录。
  const windows = new Map();
  let stopped = false;

  function update(record) {
    if (record.window.isDestroyed()) return;
    if (!record.items.length) { record.window.close(); return; }
    const area = screen.getDisplayMatching(record.window.getBounds()).workArea;
    const width = Math.min(420, area.width - 24);
    const height = Math.min(230, area.height - 24);
    const bounds = record.window.getBounds();
    record.window.setBounds({ width, height,
      x: Math.max(area.x + 12, Math.min(bounds.x + bounds.width - width, area.x + area.width - width - 12)),
      y: Math.max(area.y + 12, Math.min(bounds.y + bounds.height - height, area.y + area.height - height - 12)),
    });
    record.window.webContents.send('reminder:data', { simulated: record.simulated,
      accountDisplay: record.accountDisplay,
      cards: record.items.map((item) => ({ ...item,
        snoozeOptions: getSnoozeOptions({ status: 'available', expiresAt: item.expiresAt }),
      })) });
  }

  function armClose(record) {
    clearTimeout(record.closeTimer);
    const close = () => {
      if (record.window.isDestroyed()) return;
      // 保存延期期间不能销毁窗口，否则用户无法判断操作结果。
      if (record.busy) { record.closeTimer = setTimeout(close, 1000); return; }
      record.window.close();
    };
    record.closeTimer = setTimeout(close, 90_000);
    record.closeTimer.unref?.();
  }

  ipcMain.handle('reminder:act', async (event, action, args = {}) => {
    const record = [...windows.values()].find((item) => item.window.webContents.id === event.sender.id);
    if (!record || event.senderFrame?.url !== pathToFileURL(reminderPage).href)
      throw new Error('提醒窗口无效');
    if (record.busy) return false;
    record.busy = true;
    try {
      if (action === 'reset') {
        if (record.simulated) throw new Error('测试提醒不能使用真实重置卡');
        const item = record.items.find((entry) => entry.creditId === args?.cardId
          && entry.expiresAt === args?.expectedExpiresAt);
        if (!item) throw new Error('卡片已变化，请重新查看提醒');
        const confirmation = await dialog.showMessageBox(record.window, {
          type: 'warning', noLink: true, buttons: ['取消', '确认立即重置'], defaultId: 0, cancelId: 0,
          message: `立即重置 ${item.cardName}？`,
          detail: `账号：${item.accountDisplay || record.accountDisplay || '待核对'}\n卡片：#${(item.originalCreditId || item.creditId).slice(-6)}\n确认后会向 Codex 发起正式用卡请求；成功后无法撤销。`,
        });
        if (confirmation.response !== 1) return { outcome: 'cancelled' };
        let result;
        try { result = await coreRequest('resetCardFromReminder', {
          cardId: item.creditId, expectedExpiresAt: item.expiresAt }); }
        catch (error) { return resetFailureResult(error); }
        if (['reset', 'alreadyRedeemed'].includes(result.outcome)) {
          record.items = record.items.filter((current) => current !== item);
          if (record.items.length) update(record);
          else setTimeout(() => { if (!record.window.isDestroyed()) record.window.close(); }, 1200);
          try { await onScheduleChanged(); } catch (error) { console.warn(`[reminder] 用卡后重排失败：${error.message}`); }
        }
        return result;
      } else if (action === 'snooze') {
        const item = record.items.find((item) => item.creditId === args?.cardId);
        if (!item || !['1d', '3d', 'tomorrow10'].includes(args?.option)) throw new Error('提醒时间或卡片无效');
        if (!record.simulated) {
          await coreRequest('scheduleSnooze', { cardId: item.creditId, option: args.option,
            expectedExpiresAt: item.expiresAt, scopeId: item.accountScopeId });
          await onScheduleChanged();
        }
        // 新节点可能在保存期间加入；只移除用户刚处理的那条。
        record.items = record.items.filter((current) => current !== item);
        update(record);
      } else if (action === 'dismiss') record.window.close();
      else throw new Error('未知的提醒操作');
      return true;
    } finally { record.busy = false; }
  });

  async function present(payload) {
    if (stopped) throw new Error('提醒已停止');
    const items = mergeReminderItems([], payload.cards || [payload]);
    if (!items.length) return;
    const simulated = payload.simulated === true;
    const key = simulated ? 'simulation' : 'real';
    let record = windows.get(key);
    if (record) {
      record.items = mergeReminderItems(record.items, items);
      record.accountDisplay = payload.accountDisplay || record.accountDisplay;
      await record.ready;
      if (record.window.isDestroyed()) throw new Error('提醒窗口已关闭，请稍后重试');
      update(record);
      armClose(record);
      record.window.showInactive();
      return;
    }
    const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
    const window = new BrowserWindow({
      width: 420, height: 230, x: area.x + area.width - 436, y: area.y + area.height - 246,
      frame: false, resizable: false, movable: true, alwaysOnTop: true, skipTaskbar: true, show: false,
      webPreferences: { preload: join(import.meta.dirname, 'preload.cjs'), contextIsolation: true,
        nodeIntegration: false, sandbox: true },
    });
    record = { window, items, simulated, accountDisplay: payload.accountDisplay || null,
      busy: false, ready: null, closeTimer: null };
    windows.set(key, record);
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', (event) => event.preventDefault());
    const expiryTimer = setInterval(() => {
      const remaining = record.items.filter((item) => item.expiresAt > Date.now() / 1000);
      if (remaining.length !== record.items.length) { record.items = remaining; update(record); }
    }, 1000);
    expiryTimer.unref?.();
    window.on('closed', () => {
      clearTimeout(record.closeTimer); clearInterval(expiryTimer);
      if (windows.get(key) === record) windows.delete(key);
    });
    record.ready = window.loadFile(reminderPage).then(() => {
      if (window.isDestroyed()) throw new Error('提醒窗口已关闭，请稍后重试');
      update(record); armClose(record); window.showInactive();
    });
    try { await record.ready; }
    catch (error) { if (!window.isDestroyed()) window.close(); throw error; }
  }

  return { present,
    reconcile(snapshot) {
      const record = windows.get('real');
      if (!record) return;
      const remaining = record.items.filter((item) => reminderStillActive(item, snapshot)).map((item) => {
        const card = snapshot.cards.find((card) => card.id === item.creditId);
        return { ...item, accountReady: card.accountReady ?? item.accountReady,
          accountDisplay: card.accountDisplay || item.accountDisplay };
      });
      if (remaining.length !== record.items.length || remaining.some((item, i) =>
        item.accountReady !== record.items[i].accountReady || item.accountDisplay !== record.items[i].accountDisplay)) {
        record.items = remaining; update(record);
      }
    },
    closeAll() {
      stopped = true;
      for (const { window } of windows.values()) if (!window.isDestroyed()) window.close();
      windows.clear();
    },
  };
}
