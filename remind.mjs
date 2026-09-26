import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dueThreshold, showNotification } from './check.mjs';
import { sendFeishuReminder } from './feishu.mjs';
import { sendWechatReminder } from './wechat.mjs';
import { deliveryTime, enabledChannels, quietHours } from './reminder-policy.mjs';
import { safeDeliveryFailure } from './core/delivery-results.mjs';
import { mayAttemptReminder, nextRetryAfter } from './core/delivery-retry.mjs';
import { clearSnooze, deliveryExists, getSnooze, latestCompleteSync, latestSync, listCards, listDueSnoozes,
  beginReminderAttempt, getReminderAttempt, markSnoozeDelivered, openStore, recordDelivery,
  recordFeishuMessage, recordReminderResult } from './store.mjs';

const directory = dirname(fileURLToPath(import.meta.url));

export async function runReminders({ nowSeconds = Math.floor(Date.now() / 1000),
  configPath = join(directory, 'config.json'), desktop = showNotification,
  feishu = sendFeishuReminder, wechat = sendWechatReminder, dryRun = false,
  trackAttempts = false, manualRetry = null, allowCodex = true, accountScopeId = null } = {}) {
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  const channels = enabledChannels(config);
  const quiet = quietHours(config);
  const db = openStore();
  const results = [];
  let shownIndex = 0;
  try {
    const saveResult = (node, channel, state, error = null) => {
      if (!trackAttempts || dryRun) return error ? `failed: ${error.message}` : state;
      const failure = error ? safeDeliveryFailure(error, channel) : null;
      const attempts = getReminderAttempt(db, { ...node, channel })?.attempts ?? 1;
      const plannedRetry = error ? nextRetryAfter(attempts, nowSeconds) : null;
      recordReminderResult(db, node, channel, { state: error ? 'failed' : 'sent',
        attemptedAt: nowSeconds, nextRetryAt: plannedRetry < node.expiresAt ? plannedRetry : null,
        errorCode: failure?.code, errorText: failure?.text });
      return error ? `failed: ${failure.text}` : state;
    };
    const maySend = (node, channel) => {
      if (!trackAttempts || dryRun) return !manualRetry;
      if (manualRetry && (manualRetry.cardId !== node.cardId
        || manualRetry.expiresAt !== node.expiresAt
        || manualRetry.nodeKind !== node.nodeKind || manualRetry.nodeAt !== node.nodeAt)) return false;
      if (nowSeconds < deliveryTime(nowSeconds, node.expiresAt, quiet)) return false;
      const attempt = getReminderAttempt(db, { ...node, channel });
      if (attempt?.nextRetryAt && !manualRetry
        && nowSeconds < deliveryTime(attempt.nextRetryAt, node.expiresAt, quiet)) return false;
      return mayAttemptReminder(attempt, nowSeconds, Boolean(manualRetry));
    };
    const begin = (node, channel) => {
      if (trackAttempts && !dryRun) beginReminderAttempt(db, node, channel, nowSeconds);
    };
    const cards = listCards(db);
    const lastCompleteSync = latestCompleteSync(db);
    const syncedCount = lastCompleteSync?.availableCount ?? null;
    const syncedAt = lastCompleteSync?.checkedAt ?? null;
    for (const card of cards) {
      if (card.source === 'codex' && (!allowCodex
        || (accountScopeId && card.accountScopeId !== accountScopeId))) continue;
      const days = dueThreshold(card.expiresAt, nowSeconds);
      if (days === null) continue;
      const nodeAt = card.expiresAt - days * 86400;
      const node = { cardId: card.id, expiresAt: card.expiresAt, nodeKind: 'fixed', nodeAt,
        thresholdDays: days };
      if (nowSeconds < deliveryTime(nodeAt, card.expiresAt, quiet)) continue;
      const snooze = getSnooze(db, card.id);
      if (snooze?.expiresAt === card.expiresAt
        && snooze.targetAt >= nodeAt) continue;
      const result = { id: card.id, title: card.title, expiresAt: card.expiresAt, days,
        desktop: channels.includes('desktop') ? 'already_sent' : 'disabled',
        feishu: channels.includes('feishu') ? 'already_sent' : 'disabled',
        wechat: channels.includes('wechat') ? 'already_sent' : 'disabled' };
      if (!deliveryExists(db, card.id, card.expiresAt, days, 'feishu')
        && channels.includes('feishu') && maySend(node, 'feishu')) {
        result.feishu = 'due';
        if (!dryRun) {
          try {
            begin(node, 'feishu');
            const sent = await feishu(config, card, days, { currentAvailableCount: syncedCount, syncedAt });
            if (sent?.messageId && config.feishu.userId) {
              recordFeishuMessage(db, { messageId: sent.messageId, cardId: card.id,
                expiresAt: card.expiresAt, thresholdDays: days, recipientOpenId: config.feishu.userId });
            }
            recordDelivery(db, card.id, card.expiresAt, days, 'feishu');
            result.feishu = saveResult(node, 'feishu', 'sent');
          } catch (error) { result.feishu = saveResult(node, 'feishu', 'failed', error); }
        }
      }
      if (!deliveryExists(db, card.id, card.expiresAt, days, 'wechat')
        && channels.includes('wechat') && maySend(node, 'wechat')) {
        result.wechat = 'due';
        if (!dryRun) {
          try {
            begin(node, 'wechat');
            await wechat(config, card, days, { currentAvailableCount: syncedCount });
            recordDelivery(db, card.id, card.expiresAt, days, 'wechat');
            result.wechat = saveResult(node, 'wechat', 'sent');
          } catch (error) { result.wechat = saveResult(node, 'wechat', 'failed', error); }
        }
      }
      if (!deliveryExists(db, card.id, card.expiresAt, days, 'desktop')
        && channels.includes('desktop') && maySend(node, 'desktop')) {
        result.desktop = 'due';
        if (!dryRun) {
          try {
            begin(node, 'desktop');
            await desktop({ cardName: card.title, creditId: card.id, source: card.source,
              expiresAt: card.expiresAt,
              expiresLocal: new Date(card.expiresAt * 1000).toLocaleString('zh-CN', { hour12: false }),
              days, currentAvailableCount: syncedCount, syncedAt, stackIndex: shownIndex });
            recordDelivery(db, card.id, card.expiresAt, days, 'desktop');
            shownIndex++;
            result.desktop = saveResult(node, 'desktop', 'shown');
          } catch (error) { result.desktop = saveResult(node, 'desktop', 'failed', error); }
        }
      }
      results.push(result);
    }
    for (const snooze of listDueSnoozes(db, nowSeconds)) {
      const card = cards.find((item) => item.id === snooze.cardId);
      if (!card) continue;
      if (card.source === 'codex' && (!allowCodex
        || (accountScopeId && card.accountScopeId !== accountScopeId))) continue;
      if (nowSeconds < deliveryTime(snooze.targetAt, card.expiresAt, quiet)) continue;
      const days = dueThreshold(card.expiresAt, nowSeconds);
      if (days !== null && snooze.targetAt < card.expiresAt - days * 86400) {
        if (!dryRun) clearSnooze(db, card.id);
        continue;
      }
      const feishuDone = !channels.includes('feishu') || Boolean(snooze.feishuDeliveredAt);
      const wechatDone = !channels.includes('wechat') || Boolean(snooze.wechatDeliveredAt);
      const desktopDone = !channels.includes('desktop') || Boolean(snooze.desktopDeliveredAt);
      if (desktopDone && feishuDone && wechatDone) continue;
      const remainingDays = Math.max(0, Math.ceil((card.expiresAt - nowSeconds) / 86400));
      const node = { cardId: card.id, expiresAt: card.expiresAt, nodeKind: 'snooze',
        nodeAt: snooze.targetAt, thresholdDays: 0 };
      const result = { id: card.id, title: card.title, expiresAt: card.expiresAt, days: remainingDays,
        snooze: true, desktop: !channels.includes('desktop') ? 'disabled'
          : snooze.desktopDeliveredAt ? 'already_sent' : 'due',
        feishu: !channels.includes('feishu') ? 'disabled'
          : snooze.feishuDeliveredAt ? 'already_sent' : 'due',
        wechat: !channels.includes('wechat') ? 'disabled'
          : snooze.wechatDeliveredAt ? 'already_sent' : 'due' };
      if (channels.includes('feishu') && !snooze.feishuDeliveredAt && !dryRun
        && maySend(node, 'feishu')) {
        try {
          begin(node, 'feishu');
          const sent = await feishu(config, card, remainingDays,
            { currentAvailableCount: syncedCount, syncedAt, snoozeTargetAt: snooze.targetAt });
          if (sent?.messageId && config.feishu.userId) {
            recordFeishuMessage(db, { messageId: sent.messageId, cardId: card.id,
              expiresAt: card.expiresAt, thresholdDays: remainingDays, recipientOpenId: config.feishu.userId });
          }
          recordDelivery(db, card.id, card.expiresAt, 0, 'feishu');
          markSnoozeDelivered(db, card.id, 'feishu');
          result.feishu = saveResult(node, 'feishu', 'sent');
        } catch (error) { result.feishu = saveResult(node, 'feishu', 'failed', error); }
      }
      if (channels.includes('wechat') && !snooze.wechatDeliveredAt && !dryRun
        && maySend(node, 'wechat')) {
        try {
          begin(node, 'wechat');
          await wechat(config, card, remainingDays,
            { currentAvailableCount: syncedCount, snoozeTargetAt: snooze.targetAt });
          recordDelivery(db, card.id, card.expiresAt, 0, 'wechat');
          markSnoozeDelivered(db, card.id, 'wechat');
          result.wechat = saveResult(node, 'wechat', 'sent');
        } catch (error) { result.wechat = saveResult(node, 'wechat', 'failed', error); }
      }
      if (channels.includes('desktop') && !snooze.desktopDeliveredAt && !dryRun
        && maySend(node, 'desktop')) {
        try {
          begin(node, 'desktop');
          await desktop({ cardName: card.title, creditId: card.id, source: card.source,
            expiresAt: card.expiresAt,
            expiresLocal: new Date(card.expiresAt * 1000).toLocaleString('zh-CN', { hour12: false }),
            days: remainingDays, currentAvailableCount: syncedCount, syncedAt, stackIndex: shownIndex });
          recordDelivery(db, card.id, card.expiresAt, 0, 'desktop');
          markSnoozeDelivered(db, card.id, 'desktop');
          shownIndex++;
          result.desktop = saveResult(node, 'desktop', 'shown');
        } catch (error) { result.desktop = saveResult(node, 'desktop', 'failed', error); }
      }
      results.push(result);
    }
    return { checkedAt: new Date(nowSeconds * 1000).toISOString(), latestSync: latestSync(db),
      cachedCards: cards.length, due: results };
  } finally { db.close(); }
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  runReminders({ dryRun: process.argv.includes('--dry-run') }).then((result) => {
    const hasFailure = result.due.some((row) => ['desktop', 'feishu', 'wechat']
      .some((channel) => row[channel].startsWith('failed:')));
    const hasActivity = result.due.some((row) => ['desktop', 'feishu', 'wechat']
      .some((channel) => ['sent', 'shown', 'due'].includes(row[channel])));
    if (!process.argv.includes('--quiet') || hasFailure || hasActivity) {
      console.log(JSON.stringify(result, null, 2));
    }
    if (hasFailure) process.exitCode = 1;
  }).catch((error) => { console.error(error.message); process.exitCode = 1; });
}
