// 桌面提醒的正式用卡入口。重启或结果不明后复用同一幂等键。
import { randomUUID } from 'node:crypto';
import { consumeCredit } from '../legacy/node/consume.mjs';
import { clearDesktopResetKey, desktopResetKey, getCard, openStore } from '../core/store.mjs';
import { requireCardInScope } from './account-guard.mjs';

const inFlight = new Map();

export function resetCardFromReminder({ cardId, expectedExpiresAt },
  { verifyAccount, consume = consumeCredit, verifyCard = requireCardInScope,
    openDb = openStore, newKey = randomUUID } = {}) {
  if (typeof cardId !== 'string' || !cardId || !Number.isInteger(expectedExpiresAt))
    throw new Error('重置卡信息无效');
  if (typeof verifyAccount !== 'function') throw new Error('缺少账号核对');
  const flightKey = `${cardId}:${expectedExpiresAt}`;
  if (inFlight.has(flightKey)) return inFlight.get(flightKey);
  const pending = (async () => {
    const scopeId = await verifyAccount();
    let key;
    const db = openDb();
    try {
      const card = getCard(db, cardId);
      if (card?.source !== 'codex' || card.accountScopeId !== scopeId
        || card.expiresAt !== expectedExpiresAt || card.expiresAt <= Date.now() / 1000
        || card.status !== 'available') {
        const error = new Error('这张卡已变化，请重新查看卡片列表');
        error.code = 'ACCOUNT_CARD_CHANGED';
        throw error;
      }
      key = desktopResetKey(db, cardId, expectedExpiresAt, newKey());
    } finally { db.close(); }
    // consumeCredit 会在请求前后重新核对账号，并核对卡片归属。
    const result = await consume(cardId, key, { verifyAccount, verifyCard });
    if (['nothingToReset', 'noCredit'].includes(result.outcome)) {
      const after = openDb();
      try { clearDesktopResetKey(after, cardId, expectedExpiresAt, key); }
      finally { after.close(); }
    }
    return result;
  })().finally(() => inFlight.delete(flightKey));
  inFlight.set(flightKey, pending);
  return pending;
}
