import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dueThreshold } from './check.mjs';
import { deliveryTime, enabledChannels, quietHours } from './reminder-policy.mjs';
import { syncCards } from './sync.mjs';
import { deliveryExists, getSnooze, latestSync, listCards, openStore } from './store.mjs';

const directory = dirname(fileURLToPath(import.meta.url));

export async function preflightSync({ nowSeconds = Math.floor(Date.now() / 1000),
  configPath = join(directory, 'config.json'), sync = syncCards } = {}) {
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  const options = config.reminders?.preflightSync;
  if (options?.enabled === false) return { attempted: false, reason: 'disabled' };
  const channels = enabledChannels(config);
  if (!channels.length) return { attempted: false, reason: 'no_channels' };
  const quiet = quietHours(config);
  const db = openStore();
  let due = false;
  try {
    const lastAttempt = latestSync(db)?.checkedAt ?? 0;
    const retrySeconds = Math.max(60, Number(options?.retryMinutes ?? 60) * 60);
    if (nowSeconds - lastAttempt < retrySeconds) {
      return { attempted: false, reason: 'recent_sync' };
    }
    for (const card of listCards(db)) {
      if (card.source !== 'codex') continue;
      const days = dueThreshold(card.expiresAt, nowSeconds);
      const snooze = getSnooze(db, card.id);
      const activeSnooze = snooze?.expiresAt === card.expiresAt ? snooze : null;
      if (days !== null) {
        const nodeAt = card.expiresAt - days * 86400;
        const covered = activeSnooze && activeSnooze.targetAt >= nodeAt;
        if (!covered && nowSeconds >= deliveryTime(nodeAt, card.expiresAt, quiet)
          && channels.some((channel) => !deliveryExists(db, card.id, card.expiresAt, days, channel))) {
          due = true;
          break;
        }
      }
      if (activeSnooze && activeSnooze.targetAt <= nowSeconds
        && nowSeconds >= deliveryTime(activeSnooze.targetAt, card.expiresAt, quiet)
        && channels.some((channel) => !activeSnooze[`${channel}DeliveredAt`])) {
        due = true;
        break;
      }
    }
  } finally { db.close(); }
  if (!due) return { attempted: false, reason: 'nothing_due' };
  try {
    const result = await sync(configPath, { patchMessages: false });
    return { attempted: true, ok: true, complete: result.complete };
  } catch (error) {
    // The scheduled reminder must continue from cached cards while Codex is offline.
    return { attempted: true, ok: false, reason: error.message };
  }
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  preflightSync().then((result) => {
    if (!process.argv.includes('--quiet') || result.attempted) {
      console.log(result.ok === false
        ? `提醒前同步失败，继续使用本地缓存：${result.reason}`
        : result.attempted ? `提醒前已核对 Codex${result.complete ? '' : '；详情不完整，保留缓存'}`
          : `未执行提醒前同步：${result.reason}`);
    }
  }).catch((error) => { console.error(error.message); process.exitCode = 1; });
}
