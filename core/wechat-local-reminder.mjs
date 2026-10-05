import { createHash } from 'node:crypto';
import { buildPushplusReminder } from './pushplus.mjs';
import { openStore } from './store.mjs';

const fail = (code, message) => Object.assign(new Error(message), { code });

// The local gateway receives only reminder text and a hash of the account/card
// node. Codex credentials and full card identifiers never leave this process.
export function buildLocalWechatReminder(config, card, days, options = {}) {
  if (config.wechat?.provider !== 'local-gateway' || !config.wechat.gatewayClientFile)
    throw fail('WECHAT_CONFIGURATION', '请在“设置 → 提醒”中选择微信网关调用文件。');
  const nodeKind = options.nodeKind || (options.snoozeTargetAt ? 'snooze' : 'fixed');
  const nodeAt = options.nodeAt ?? options.snoozeTargetAt ?? card?.expiresAt - days * 86400;
  if (!['fixed', 'snooze'].includes(nodeKind) || !Number.isInteger(nodeAt))
    throw fail('WECHAT_CONFIGURATION', '微信提醒节点无效。');
  let reminder;
  try { reminder = buildPushplusReminder(card, days, options); }
  catch { throw fail('WECHAT_CONFIGURATION', '微信提醒缺少有效卡片或官方到期时间。'); }
  const id = createHash('sha256').update(JSON.stringify([
    'wechat-local-v1', config.wechat.gatewayClientFile, card.accountScopeId || options.accountScopeId || null,
    card.id, card.expiresAt, nodeKind, nodeAt,
  ])).digest('hex');
  return { id: `reset-${id}`, title: reminder.title.slice(0, 100), text: reminder.content };
}

export async function sendLocalWechatReminder(config, card, days, options = {}) {
  const candidate = buildLocalWechatReminder(config, card, days, options);
  if (typeof options.transport !== 'function')
    throw fail('WECHAT_LOCAL_OFFLINE', '本机微信网关调用入口不可用。');
  // Freeze the initial text for this node. A later count/name/day change during
  // an unsent retry must not conflict with the gateway's same-ID payload hash.
  const db = (options.openDb || openStore)();
  let payload;
  try {
    db.prepare('INSERT OR IGNORE INTO wechat_local_payloads (notification_id, payload_json) VALUES (?, ?)')
      .run(candidate.id, JSON.stringify(candidate));
    payload = JSON.parse(db.prepare('SELECT payload_json FROM wechat_local_payloads WHERE notification_id = ?').get(candidate.id).payload_json);
    if (payload.id !== candidate.id || typeof payload.text !== 'string' || typeof payload.title !== 'string') throw new Error();
  } catch { throw fail('WECHAT_CONFIGURATION', '微信提醒发送记录无法保存，未提交通知。'); }
  finally { db.close(); }
  try {
    const result = await options.transport(config, payload);
    if (result?.state === 'unsent' && result.unsent === true && /^WECHAT_LOCAL_/.test(result.code || ''))
      throw fail(result.code, '本机微信网关未发送，请检查连接和来源权限。');
    if (result?.state === 'rejected') throw fail(result.code === 'WECHAT_SESSION_EXPIRED'
      ? 'WECHAT_SESSION_EXPIRED' : 'WECHAT_REJECTED', '微信拒绝此通知，请核对连接和会话状态。');
    if (result?.state !== 'accepted' && (result?.ok !== true || result.confirmation !== 'accepted')) throw new Error();
    return { ok: true, confirmation: 'accepted', messageId: payload.id };
  } catch (error) {
    if (/^WECHAT_LOCAL_/.test(error?.code || '')
      || ['WECHAT_CONFIGURATION', 'WECHAT_REJECTED', 'WECHAT_SESSION_EXPIRED'].includes(error?.code)) throw error;
    throw fail('WECHAT_UNKNOWN', '微信发送结果未知，已停止补发，请到手机核对。');
  }
}
