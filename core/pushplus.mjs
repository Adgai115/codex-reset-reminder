import { createHash } from 'node:crypto';
import { openStore } from './store.mjs';
import { pushplusUnknown, requestPushplus } from './pushplus-http.mjs';

const oneLine = (value, fallback) => String(value || fallback).replace(/[\r\n\t]/g, ' ').slice(0, 100);

export function buildPushplusReminder(card, days, { accountDisplay = null,
  currentAvailableCount = null, nodeKind = 'fixed', snoozeTargetAt = null,
  nowSeconds = Math.floor(Date.now() / 1000) } = {}) {
  if (!card || typeof card.id !== 'string' || !card.id || !Number.isInteger(card.expiresAt)
    || !Number.isFinite(new Date(card.expiresAt * 1000).getTime())) {
    const error = new Error('微信提醒缺少有效卡片或官方到期时间。');
    error.code = 'PUSHPLUS_CONFIGURATION';
    throw error;
  }
  const account = oneLine(accountDisplay, 'Codex 账号待核对');
  const cardName = oneLine(card.title, 'Codex 重置卡');
  const cardNumber = oneLine(card.creditId || card.id, '').slice(-6);
  const expires = new Date(card.expiresAt * 1000).toLocaleString('zh-CN', { hour12: false });
  const count = Number.isInteger(currentAvailableCount) && currentAvailableCount >= 0
    ? `${currentAvailableCount} 张` : '待同步';
  const threshold = Number.isInteger(days) && days >= 0 ? `${days} 天` : '待核对';
  const remainingDays = Math.max(0, Math.ceil((card.expiresAt - nowSeconds) / 86400));
  return { title: `${account} · Codex 重置卡到期提醒`, content: [
    `账号：${account}`, `卡片：${cardName} · #${cardNumber}`, `官方到期时间：${expires}`,
    `剩余时间：约 ${remainingDays} 天`,
    nodeKind === 'snooze' || snoozeTargetAt ? `提醒：延期提醒，距离到期约 ${threshold}` : `提醒节点：到期前 ${threshold}`,
    `最近同步可用卡：${count}`, '请在 Codex 重置卡提醒应用中查看；立即重置需在应用内确认。',
  ].join('\n'), template: 'txt', channel: 'wechat' };
}

function ledgerKey(config, card, days, options) {
  const nodeKind = options.nodeKind || (options.snoozeTargetAt ? 'snooze' : 'fixed');
  const nodeAt = options.nodeAt ?? options.snoozeTargetAt ?? card.expiresAt - days * 86400;
  if (!['fixed', 'snooze'].includes(nodeKind) || !Number.isInteger(nodeAt))
    throw Object.assign(new Error('微信提醒节点无效。'), { code: 'PUSHPLUS_CONFIGURATION' });
  const credentialId = options.credentialId || config.wechat?.credentialId;
  if (!credentialId && !options.token)
    throw Object.assign(new Error('微信 PushPlus 连接未配置，请在“设置 → 提醒”中配置。'), { code: 'PUSHPLUS_CONFIGURATION' });
  // A fingerprint is the only credential-derived value stored in SQLite.
  const identity = createHash('sha256').update(credentialId ? `id:${credentialId}` : `token:${options.token}`).digest('hex');
  return [card.id, card.expiresAt, nodeKind, nodeAt, identity];
}

function withStore(openDb, operation) {
  const db = openDb();
  try { return operation(db); } finally { db.close(); }
}

function claimSubmission(openDb, key, nowSeconds) {
  return withStore(openDb, (db) => {
    db.exec('BEGIN IMMEDIATE');
    try {
      const existing = db.prepare(`SELECT state, message_id AS messageId FROM pushplus_submissions
        WHERE card_id = ? AND expires_at = ? AND node_kind = ? AND node_at = ? AND credential_id = ?`).get(...key);
      if (existing?.state === 'unknown') throw pushplusUnknown();
      if (existing?.state === 'accepted') { db.exec('COMMIT'); return existing; }
      db.prepare(`INSERT INTO pushplus_submissions (card_id, expires_at, node_kind, node_at, credential_id, state, updated_at)
        VALUES (?, ?, ?, ?, ?, 'unknown', ?)
        ON CONFLICT(card_id, expires_at, node_kind, node_at, credential_id) DO UPDATE SET
          state = 'unknown', message_id = NULL, updated_at = excluded.updated_at`).run(...key, nowSeconds);
      db.exec('COMMIT');
      return null;
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  });
}

function completeSubmission(openDb, key, state, messageId, nowSeconds) {
  withStore(openDb, (db) => db.prepare(`UPDATE pushplus_submissions SET state = ?, message_id = ?, updated_at = ?
    WHERE card_id = ? AND expires_at = ? AND node_kind = ? AND node_at = ? AND credential_id = ?`)
    .run(state, messageId, nowSeconds, ...key));
}

export async function sendPushplusReminder(config, card, days, options = {}) {
  const payload = buildPushplusReminder(card, days, options);
  const key = ledgerKey(config, card, days, options);
  const openDb = options.openDb || openStore;
  const nowSeconds = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  const existing = claimSubmission(openDb, key, nowSeconds);
  if (existing) return { ok: true, confirmation: 'accepted', messageId: existing.messageId };
  // Persist unknown before invoking any transport, including the main-process
  // bridge. A crash or lost reply must never trigger a second POST after restart.
  try {
    const result = options.transport ? await options.transport(config, payload)
      : await requestPushplus(payload, options);
    if (result?.ok !== true || result.confirmation !== 'accepted'
      || typeof result.messageId !== 'string' || !/^[a-z0-9_-]{1,128}$/i.test(result.messageId))
      throw pushplusUnknown();
    completeSubmission(openDb, key, 'accepted', result.messageId, nowSeconds);
    return { ok: true, confirmation: 'accepted', messageId: result.messageId };
  } catch (error) {
    if (['PUSHPLUS_REJECTED', 'PUSHPLUS_CONFIGURATION', 'PUSHPLUS_LIMITED'].includes(error?.code)) {
      completeSubmission(openDb, key, 'rejected', null, nowSeconds);
      throw Object.assign(new Error(error.code === 'PUSHPLUS_REJECTED'
        ? '微信 PushPlus 拒绝提交；请检查连接、公众号关注及服务额度。'
        : error.code === 'PUSHPLUS_LIMITED' ? '微信 PushPlus 账号受限；已停止自动补发，请在 PushPlus 核对并恢复后再试。'
        : '微信 PushPlus 连接未配置或无效，请在“设置 → 提醒”中配置。'), { code: error.code });
    }
    throw pushplusUnknown();
  }
}

// Explicit user-triggered tests contain no real account/card information and do
// not create or modify production reminder nodes or delivery history.
export async function sendPushplusTest(config, options = {}) {
  const payload = { title: 'Codex 重置卡提醒 · 微信测试',
    content: '这是一条微信渠道测试通知。\n测试不包含真实账号或卡片，不会使用重置卡。\n看到此消息后，微信接收已验证。',
    template: 'txt', channel: 'wechat' };
  return options.transport ? options.transport(config, payload) : requestPushplus(payload, options);
}
