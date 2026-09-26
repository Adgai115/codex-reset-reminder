import { powerMonitor } from 'electron';

const hourMs = 60 * 60 * 1000;
const maxTimeoutMs = 2_147_483_647;

export function createScheduler({ coreRequest, onResult = () => {}, onChanged = () => {} }) {
  let running = false;
  let hourlyTimer = null;
  let dailyTimer = null;
  let exactTimer = null;
  let queue = Promise.resolve();
  let syncPromise = null;
  const retrying = new Map();

  function enqueue(task) {
    const result = queue.catch(() => {}).then(task);
    queue = result.catch((error) => {
      console.error(`[scheduler] ${error.message}`);
    });
    return result;
  }

  async function reschedule() {
    if (!running) return;
    clearTimeout(exactTimer);
    const plan = await coreRequest('planNextCheck');
    if (!plan.nextAt) return;
    const delay = Math.min(maxTimeoutMs, Math.max(1000, plan.nextAt * 1000 - Date.now() + 1000));
    exactTimer = setTimeout(() => { check('exact'); }, delay);
  }

  async function performCheck(reason, options = {}) {
    if (!running) return;
    try {
      const due = await coreRequest('dueUsageVerifications');
      if (due.length) {
        try { await coreRequest('syncCards'); }
        catch (error) { console.warn(`[scheduler] 使用核验暂不可用：${error.message}`); }
      }
      try { await coreRequest('preflightSync'); }
      catch (error) { console.warn(`[scheduler] 提醒前核对失败：${error.message}`); }
      const result = await coreRequest('runReminders', options);
      onResult(result, reason);
      return result;
    } finally { await reschedule(); onChanged(); }
  }

  function check(reason = 'manual') { return enqueue(() => performCheck(reason)); }

  function retry(node) {
    const key = `${node?.cardId}:${node?.expiresAt}:${node?.nodeKind}:${node?.nodeAt}`;
    if (!node?.cardId || !Number.isInteger(node?.expiresAt)
      || !['fixed', 'snooze'].includes(node?.nodeKind) || !Number.isInteger(node?.nodeAt)) {
      throw new Error('重试节点无效');
    }
    if (retrying.has(key)) return retrying.get(key);
    const pending = enqueue(() => performCheck('manual-retry', { manualRetry: node }))
      .finally(() => { retrying.delete(key); onChanged(); });
    retrying.set(key, pending);
    onChanged();
    return pending;
  }

  function sync(reason = 'manual') {
    if (syncPromise) return syncPromise;
    const result = enqueue(async () => {
      try { return await coreRequest('syncCards'); }
      finally { await reschedule(); }
    });
    syncPromise = result.finally(() => { syncPromise = null; onChanged(); });
    onChanged();
    syncPromise.then(() => check(`after-${reason}`), () => check(`after-${reason}-failed`)).catch(() => {});
    return syncPromise;
  }

  function scheduleDaily() {
    if (!running) return;
    const next = new Date();
    next.setHours(8, 30, 0, 0);
    if (next.getTime() <= Date.now()) next.setDate(next.getDate() + 1);
    dailyTimer = setTimeout(async () => {
      try { await sync('daily'); }
      catch (error) { console.warn(`[scheduler] 每日同步失败：${error.message}`); }
      finally { scheduleDaily(); }
    }, next.getTime() - Date.now());
  }

  const resume = () => { check('resume'); };
  function start() {
    if (running) return;
    running = true;
    powerMonitor.on('resume', resume);
    hourlyTimer = setInterval(() => check('hourly'), hourMs);
    scheduleDaily();
    sync('startup').catch((error) => console.warn(`[scheduler] 启动同步失败，继续使用本地缓存：${error.message}`));
  }
  function stop() {
    running = false;
    clearInterval(hourlyTimer);
    clearTimeout(dailyTimer);
    clearTimeout(exactTimer);
    powerMonitor.removeListener('resume', resume);
  }
  return { start, stop, check, retry, sync, isSyncing: () => Boolean(syncPromise),
    isRetrying: () => retrying.size > 0, reschedule: () => enqueue(reschedule) };
}
