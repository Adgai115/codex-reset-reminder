import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dueThreshold, showNotification } from './check.mjs';
import { sendFeishuReminder } from './feishu.mjs';
import { sendWechatReminder } from './wechat.mjs';
import { deliveryTime, enabledChannels, quietHours } from './reminder-policy.mjs';
import { clearSnooze, deliveryExists, getSnooze, latestCompleteSync, latestSync, listCards, listDueSnoozes,
  markSnoozeDelivered, openStore, recordDelivery, recordFeishuMessage } from './store.mjs';

const directory = dirname(fileURLToPath(import.meta.url));

export async function runReminders({ nowSeconds = Math.floor(Date.now() / 1000),
  configPath = join(directory, 'config.json'), desktop = showNotification,
  feishu = sendFeishuReminder, wechat = sendWechatReminder, dryRun = false } = {}) {
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  const channels = enabledChannels(config);
  const quiet = quietHours(config);
  const db = openStore();
  const results = [];
  let shownIndex = 0;
  try {
    const cards = listCards(db);
    const lastCompleteSync = latestCompleteSync(db);
    const syncedCount = lastCompleteSync?.availableCount ?? null;
    const syncedAt = lastCompleteSync?.checkedAt ?? null;
    for (const card of cards) {
      const days = dueThreshold(card.expiresAt, nowSeconds);
      if (days === null) continue;
      const nodeAt = card.expiresAt - days * 86400;
      if (nowSeconds < deliveryTime(nodeAt, card.expiresAt, quiet)) continue;
      const snooze = getSnooze(db, card.id);
      if (snooze?.expiresAt === card.expiresAt
        && snooze.targetAt >= nodeAt) continue;
      const result = { id: card.id, title: card.title, expiresAt: card.expiresAt, days,
        desktop: channels.includes('desktop') ? 'already_sent' : 'disabled',
        feishu: channels.includes('feishu') ? 'already_sent' : 'disabled',
        wechat: channels.includes('wechat') ? 'already_sent' : 'disabled' };
      if (!deliveryExists(db, card.id, card.expiresAt, days, 'feishu') && channels.includes('feishu')) {
        result.feishu = 'due';
        if (!dryRun) {
          try {
            const sent = await feishu(config, card, days, { currentAvailableCount: syncedCount, syncedAt });
            if (sent?.messageId && config.feishu.userId) {
              recordFeishuMessage(db, { messageId: sent.messageId, cardId: card.id,
                expiresAt: card.expiresAt, thresholdDays: days, recipientOpenId: config.feishu.userId });
            }
            recordDelivery(db, card.id, card.expiresAt, days, 'feishu');
            result.feishu = 'sent';
          } catch (error) { result.feishu = `failed: ${error.message}`; }
        }
      }
      if (!deliveryExists(db, card.id, card.expiresAt, days, 'wechat') && channels.includes('wechat')) {
        result.wechat = 'due';
        if (!dryRun) {
          try {
            await wechat(config, card, days, { currentAvailableCount: syncedCount });
            recordDelivery(db, card.id, card.expiresAt, days, 'wechat');
            result.wechat = 'sent';
          } catch (error) { result.wechat = `failed: ${error.message}`; }
        }
      }
      if (!deliveryExists(db, card.id, card.expiresAt, days, 'desktop') && channels.includes('desktop')) {
        result.desktop = 'due';
        if (!dryRun) {
          try {
            await desktop({ cardName: card.title, creditId: card.id, source: card.source,
              expiresAt: card.expiresAt,
              expiresLocal: new Date(card.expiresAt * 1000).toLocaleString('zh-CN', { hour12: false }),
              days, currentAvailableCount: syncedCount, syncedAt, stackIndex: shownIndex });
            recordDelivery(db, card.id, card.expiresAt, days, 'desktop');
            shownIndex++;
            result.desktop = 'shown';
          } catch (error) { result.desktop = `failed: ${error.message}`; }
        }
      }
      results.push(result);
    }
    for (const snooze of listDueSnoozes(db, nowSeconds)) {
      const card = cards.find((item) => item.id === snooze.cardId);
      if (!card) continue;
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
      const result = { id: card.id, title: card.title, expiresAt: card.expiresAt, days: remainingDays,
        snooze: true, desktop: !channels.includes('desktop') ? 'disabled'
          : snooze.desktopDeliveredAt ? 'already_sent' : 'due',
        feishu: !channels.includes('feishu') ? 'disabled'
          : snooze.feishuDeliveredAt ? 'already_sent' : 'due',
        wechat: !channels.includes('wechat') ? 'disabled'
          : snooze.wechatDeliveredAt ? 'already_sent' : 'due' };
      if (channels.includes('feishu') && !snooze.feishuDeliveredAt && !dryRun) {
        try {
          const sent = await feishu(config, card, remainingDays,
            { currentAvailableCount: syncedCount, syncedAt, snoozeTargetAt: snooze.targetAt });
          if (sent?.messageId && config.feishu.userId) {
            recordFeishuMessage(db, { messageId: sent.messageId, cardId: card.id,
              expiresAt: card.expiresAt, thresholdDays: remainingDays, recipientOpenId: config.feishu.userId });
          }
          recordDelivery(db, card.id, card.expiresAt, 0, 'feishu');
          markSnoozeDelivered(db, card.id, 'feishu');
          result.feishu = 'sent';
        } catch (error) { result.feishu = `failed: ${error.message}`; }
      }
      if (channels.includes('wechat') && !snooze.wechatDeliveredAt && !dryRun) {
        try {
          await wechat(config, card, remainingDays,
            { currentAvailableCount: syncedCount, snoozeTargetAt: snooze.targetAt });
          recordDelivery(db, card.id, card.expiresAt, 0, 'wechat');
          markSnoozeDelivered(db, card.id, 'wechat');
          result.wechat = 'sent';
        } catch (error) { result.wechat = `failed: ${error.message}`; }
      }
      if (channels.includes('desktop') && !snooze.desktopDeliveredAt && !dryRun) {
        try {
          await desktop({ cardName: card.title, creditId: card.id, source: card.source,
            expiresAt: card.expiresAt,
            expiresLocal: new Date(card.expiresAt * 1000).toLocaleString('zh-CN', { hour12: false }),
            days: remainingDays, currentAvailableCount: syncedCount, syncedAt, stackIndex: shownIndex });
          recordDelivery(db, card.id, card.expiresAt, 0, 'desktop');
          markSnoozeDelivered(db, card.id, 'desktop');
          shownIndex++;
          result.desktop = 'shown';
        } catch (error) { result.desktop = `failed: ${error.message}`; }
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
