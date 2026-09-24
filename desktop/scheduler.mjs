import { powerMonitor } from 'electron';

const hourMs = 60 * 60 * 1000;
const maxTimeoutMs = 2_147_483_647;

export function createScheduler({ coreRequest, onResult = () => {} }) {
  let running = false;
  let hourlyTimer = null;
  let dailyTimer = null;
  let exactTimer = null;
  let queue = Promise.resolve();

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

  async function performCheck(reason) {
    if (!running) return;
    try {
      const due = await coreRequest('dueUsageVerifications');
      if (due.length) {
        try { await coreRequest('syncCards'); }
        catch (error) { console.warn(`[scheduler] 使用核验暂不可用：${error.message}`); }
      }
      try { await coreRequest('preflightSync'); }
      catch (error) { console.warn(`[scheduler] 提醒前核对失败：${error.message}`); }
      const result = await coreRequest('runReminders');
      onResult(result, reason);
    } finally { await reschedule(); }
  }

  function check(reason = 'manual') { return enqueue(() => performCheck(reason)); }

  function sync(reason = 'manual') {
    const result = enqueue(async () => {
      const synced = await coreRequest('syncCards');
      await reschedule();
      return synced;
    });
    result.then(() => check(`after-${reason}`), () => {});
    return result;
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
    check('startup');
  }
  function stop() {
    running = false;
    clearInterval(hourlyTimer);
    clearTimeout(dailyTimer);
    clearTimeout(exactTimer);
    powerMonitor.removeListener('resume', resume);
  }
  return { start, stop, check, sync, reschedule: () => enqueue(reschedule) };
}
