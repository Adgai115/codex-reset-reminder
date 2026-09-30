import { createAutoSync } from './auto-sync.mjs';

const hourMs = 60 * 60 * 1000;
const maxTimeoutMs = 2_147_483_647;

export function createScheduler({ coreRequest, powerMonitor, onResult = () => {}, onChanged = () => {} }) {
  let running = false;
  let hourlyTimer = null;
  let exactTimer = null;
  let queue = Promise.resolve();
  const retrying = new Map();
  const syncingScopes = new Map();
  const automatic = createAutoSync({
    run: (reason) => enqueue(async () => {
      if (!running) return null;
      try { return await coreRequest('syncAllAccounts', { force: ['startup', 'resume', 'manual'].includes(reason) }); }
      finally { await reschedule(); }
    }),
    onChanged,
    onSettled: (reason) => { check(`after-${reason}`).catch(() => {}); },
    onError: (error) => console.warn(`[scheduler] 自动同步暂不可用，将自动重试：${error.message}`),
  });

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
    if (!running || !plan.nextAt) return;
    const delay = Math.min(maxTimeoutMs, Math.max(1000, plan.nextAt * 1000 - Date.now() + 1000));
    exactTimer = setTimeout(() => { check('exact').catch(() => {}); }, delay);
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

  const resume = () => { automatic.wake(); check('resume').catch(() => {}); };
  function start() {
    if (running) return;
    running = true;
    powerMonitor.on('resume', resume);
    hourlyTimer = setInterval(() => check('hourly').catch(() => {}), hourMs);
    automatic.start();
  }
  function stop() {
    running = false;
    clearInterval(hourlyTimer);
    automatic.stop();
    clearTimeout(exactTimer);
    powerMonitor.removeListener('resume', resume);
  }
  function sync(reason, scopeId = null) {
    if (!scopeId) return automatic.sync(reason);
    if (syncingScopes.has(scopeId)) return syncingScopes.get(scopeId);
    const pending = enqueue(async () => {
      try { return await coreRequest('syncCards', { scopeId }); }
      finally { await reschedule(); }
    }).finally(() => { syncingScopes.delete(scopeId); onChanged(); check(`after-${reason}`).catch(() => {}); });
    syncingScopes.set(scopeId, pending); onChanged();
    return pending;
  }
  return { start, stop, check, retry, sync, syncState: (scopeId) => ({ ...automatic.state(),
    syncing: automatic.state().syncing || syncingScopes.has(scopeId) }),
    isSyncing: () => automatic.state().syncing,
    isSyncingScope: (scopeId) => syncingScopes.has(scopeId),
    isRetrying: () => retrying.size > 0, reschedule: () => enqueue(reschedule) };
}
