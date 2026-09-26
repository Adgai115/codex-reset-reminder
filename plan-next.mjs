import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dueThreshold } from './check.mjs';
import { maxReminderAttempts } from './core/delivery-retry.mjs';
import { deliveryExists, getReminderAttempt, getSnooze, latestCompleteSync, listCards, openStore } from './store.mjs';
import { deliveryTime, enabledChannels, quietHours } from './reminder-policy.mjs';

const directory = dirname(fileURLToPath(import.meta.url));
const thresholds = [7, 3, 1];
const verificationDelaySeconds = 600;

export function planCardNextCheck(db, card, { channels = ['desktop'], quiet = null,
  nowSeconds = Math.floor(Date.now() / 1000), completeSyncAt = latestCompleteSync(db)?.checkedAt ?? 0 } = {}) {
  let nextAt = null;
  let nextKind = null;
  let dueAt = null;
  let dueKind = null;
  const offer = (at, kind) => {
    if (at <= nowSeconds) {
      if (dueAt === null || at > dueAt) { dueAt = at; dueKind = kind; }
    } else if (nextAt === null || at < nextAt) {
      nextAt = at;
      nextKind = kind;
    }
  };
  if (card.status === 'available' && card.expiresAt > nowSeconds) {
    const snooze = getSnooze(db, card.id);
    const activeSnooze = snooze?.expiresAt === card.expiresAt ? snooze : null;
    const currentDays = dueThreshold(card.expiresAt, nowSeconds);
    for (const days of thresholds) {
      const at = card.expiresAt - days * 86400;
      if (activeSnooze && activeSnooze.targetAt >= at) continue;
      if (at <= nowSeconds && currentDays !== days) continue;
      for (const channel of channels) {
        if (deliveryExists(db, card.id, card.expiresAt, days, channel)) continue;
        const attempt = getReminderAttempt(db, { cardId: card.id, expiresAt: card.expiresAt,
          nodeKind: 'fixed', nodeAt: at, channel });
        if (attempt) {
          if (currentDays === days && attempt.attempts < maxReminderAttempts
            && attempt.nextRetryAt && attempt.nextRetryAt < card.expiresAt) {
            offer(deliveryTime(attempt.nextRetryAt, card.expiresAt, quiet), `retry-${days}d`);
          }
        } else offer(deliveryTime(at, card.expiresAt, quiet), `${days}d`);
      }
    }
    if (activeSnooze && (currentDays === null
      || activeSnooze.targetAt >= card.expiresAt - currentDays * 86400)) {
      for (const channel of channels) {
        if (activeSnooze[`${channel}DeliveredAt`]) continue;
        const attempt = getReminderAttempt(db, { cardId: card.id, expiresAt: card.expiresAt,
          nodeKind: 'snooze', nodeAt: activeSnooze.targetAt, channel });
        if (attempt) {
          if (attempt.attempts < maxReminderAttempts && attempt.nextRetryAt
            && attempt.nextRetryAt < card.expiresAt) {
            offer(deliveryTime(attempt.nextRetryAt, card.expiresAt, quiet), 'retry-snooze');
          }
        } else offer(deliveryTime(activeSnooze.targetAt, card.expiresAt, quiet), 'snooze');
      }
    }
    if (card.source === 'codex' && card.reportedUsedAt !== null) {
      const at = card.reportedUsedAt + verificationDelaySeconds;
      if (completeSyncAt < at) offer(at, 'verify');
    }
  }
  return { nextAt, nextKind, dueAt, dueKind };
}

export function planNextCheck(db, { feishuEnabled = false, wechatEnabled = false,
  channels = null, quiet = null, nowSeconds = Math.floor(Date.now() / 1000),
  accountScopeId = null } = {}) {
  let nextAt = null;
  let reason = null;
  const completeSyncAt = latestCompleteSync(db)?.checkedAt ?? 0;
  const activeChannels = channels ?? ['desktop',
    ...(feishuEnabled ? ['feishu'] : []), ...(wechatEnabled ? ['wechat'] : [])];
  for (const card of listCards(db)) {
    if (card.source === 'codex' && accountScopeId
      && card.accountScopeId !== accountScopeId) continue;
    const plan = planCardNextCheck(db, card,
      { channels: activeChannels, quiet, nowSeconds, completeSyncAt });
    if (plan.nextAt !== null && (nextAt === null || plan.nextAt < nextAt)) {
      nextAt = plan.nextAt;
      reason = `${card.id}:${plan.nextKind}`;
    }
  }
  return { nextAt, reason };
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  try {
    const config = JSON.parse(readFileSync(join(directory, 'config.json'), 'utf8'));
    const db = openStore();
    try {
      const plan = planNextCheck(db, { channels: enabledChannels(config), quiet: quietHours(config) });
      console.log(JSON.stringify(plan));
    }
    finally { db.close(); }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
