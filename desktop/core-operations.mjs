// Electron 主进程和 Node sidecar 共用同一组数据库操作。
import * as store from '../core/store.mjs';
import { planSnooze } from '../core/later.mjs';
import { syncCards } from '../sync.mjs';

const value = (input) => String(input ?? '').trim();

export async function runCoreOperation(op, args = {}) {
  if (op === 'syncCards') {
    return syncCards(process.env.CODEX_RESET_MONITOR_CONFIG_PATH);
  }

  const db = store.openStore();
  try {
    switch (op) {
      case 'listCards': return store.listCards(db, args.includeInactive === true);
      case 'getCard': return store.getCard(db, value(args.cardId));
      case 'latestSync': return store.latestSync(db);
      case 'latestCompleteSync': return store.latestCompleteSync(db);
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
