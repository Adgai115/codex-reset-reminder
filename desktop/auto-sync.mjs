const minute = 60_000;
export const syncIntervalMs = 15 * minute;
const retryDelays = [minute, 5 * minute, syncIntervalMs];

// One background loop for startup, recovery, wake and manual refresh. The caller
// supplies the protected sync operation; this loop never binds or consumes cards.
export function createAutoSync({ run, onChanged = () => {}, onSettled = () => {},
  onError = () => {}, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let running = false;
  let timer = null;
  let pending = null;
  let failures = 0;
  let nextAt = null;
  let lastStartedAt = -Infinity;

  function schedule() {
    if (!running) return;
    const delay = failures ? retryDelays[Math.min(failures, retryDelays.length) - 1] : syncIntervalMs;
    nextAt = now() + delay;
    timer = setTimer(() => { sync('automatic').catch(onError); }, delay);
  }
  function sync(reason = 'manual') {
    if (!running) return Promise.resolve(null);
    if (pending) return pending;
    clearTimer(timer);
    nextAt = null;
    lastStartedAt = now();
    pending = Promise.resolve().then(run).then((result) => {
      failures = result?.complete ? 0 : Math.min(failures + 1, retryDelays.length);
      return result;
    }, (error) => {
      failures = Math.min(failures + 1, retryDelays.length);
      throw error;
    }).finally(() => {
      pending = null;
      schedule();
      onChanged();
      if (running) onSettled(reason);
    });
    onChanged();
    return pending;
  }
  return {
    start() { if (!running) { running = true; sync('startup').catch(onError); } },
    stop() { running = false; clearTimer(timer); nextAt = null; },
    // Coalesce repeated wake events and never race an in-flight sync.
    wake() { if (running && now() - lastStartedAt >= minute) sync('resume').catch(onError); },
    sync,
    state: () => ({ syncing: Boolean(pending), nextSyncAt: nextAt === null ? null : Math.ceil(nextAt / 1000),
      recovering: failures > 0, intervalMinutes: syncIntervalMs / minute }),
  };
}
