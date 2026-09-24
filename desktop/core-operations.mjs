// Electron 主进程和 Node sidecar 共用同一组数据库操作。
import * as store from '../core/store.mjs';
import { planSnooze } from '../core/later.mjs';
import { syncCards } from '../sync.mjs';
import { runReminders } from '../remind.mjs';
import { preflightSync } from '../preflight-sync.mjs';
import { planNextCheck } from '../plan-next.mjs';
import { enabledChannels, quietHours } from '../core/reminder-policy.mjs';
import { handleCardAction } from '../core/card-actions.mjs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const value = (input) => String(input ?? '').trim();

const configPath = () => process.env.CODEX_RESET_MONITOR_CONFIG_PATH || join(import.meta.dirname, '..', 'config.json');

export async function runCoreOperation(op, args = {}, { desktop } = {}) {
  if (op === 'syncCards') {
    return syncCards(configPath());
  }
  if (op === 'runReminders') {
    return runReminders({ configPath: configPath(), desktop, ...args });
  }
  if (op === 'preflightSync') {
    return preflightSync({ configPath: configPath(),
      sync: (path, options) => syncCards(path, options), ...args });
  }
  if (op === 'handleCardAction') {
    return handleCardAction(args.event, args.config);
  }

  const db = store.openStore();
  try {
    switch (op) {
      case 'listCards': return store.listCards(db, args.includeInactive === true);
      case 'getCard': return store.getCard(db, value(args.cardId));
      case 'latestSync': return store.latestSync(db);
      case 'latestCompleteSync': return store.latestCompleteSync(db);
      case 'dueUsageVerifications': return store.listDueUsageVerifications(db);
      case 'planNextCheck': {
        const config = JSON.parse(await readFile(configPath(), 'utf8'));
        return planNextCheck(db, { channels: enabledChannels(config), quiet: quietHours(config) });
      }
      case 'snooze': return store.getSnooze(db, value(args.cardId));
      case 'addManualCard': return { id: store.addManualCard(db, {
        title: value(args.title), expiresAt: args.expiresAt,
      }) };
      case 'updateManualCard': return { updated: store.updateManualCard(db, value(args.cardId), {
        title: value(args.title), expiresAt: args.expiresAt,
      }) };
      case 'markManualUsed': {
        const card = store.getCard(db, value(args.cardId));
        if (card?.source !== 'manual' || card.status !== 'available') {
          throw new Error('只有可用的手动卡片能直接标记已使用');
        }
        return { updated: store.markCardUsed(db, card.id) };
      }
      case 'reportCardUsed': return { card: store.reportCardUsed(db, value(args.cardId)) };
      case 'scheduleSnooze': {
        const card = store.getCard(db, value(args.cardId));
        const plan = planSnooze(card, value(args.option));
        store.scheduleSnooze(db, card.id, card.expiresAt, plan.targetAt);
        return plan;
      }
      case 'clearSnooze': {
        const card = store.getCard(db, value(args.cardId));
        const snooze = card && store.getSnooze(db, card.id);
        if (card?.status !== 'available' || snooze?.expiresAt !== card.expiresAt) {
          throw new Error('这张卡片没有可取消的延期提醒');
        }
        store.clearSnooze(db, card.id);
        return { cleared: true };
      }
      default: throw new Error(`未知操作：${op}`);
    }
  } finally { db.close(); }
}
