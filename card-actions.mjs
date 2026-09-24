import { randomUUID } from 'node:crypto';
import { consumeCredit, refreshCreditStatus } from './consume.mjs';
import { patchFeishuCard, updateFeishuCard } from './feishu.mjs';
import { getSnoozeOptions, planSnooze } from './later.mjs';
import { claimCardActionEvent, completeCardActionEvent, getCard, getFeishuMessage,
  getSnooze, latestCompleteSync, markCardUsed, openStore, recordFeishuMessage,
  reportCardUsed, scheduleSnooze, setFeishuMessageStatus } from './store.mjs';

export function parseCardAction(event) {
  if (event?.type !== 'card.action.trigger' || event.action_tag !== 'button') return null;
  let value;
  try { value = JSON.parse(event.action_value); } catch { return null; }
  if (['use', 'consume', 'later', 'refresh'].includes(value?.action)) return { action: value.action };
  if (value?.action === 'snooze' && ['1d', '3d', 'tomorrow10'].includes(value.option)) {
    return { action: 'snooze', option: value.option };
  }
  return null;
}

export function isOfficialCodexCard(card) {
  return card?.source === 'codex' && Boolean(card.id);
}

async function waitForFeishuMessage(db, messageId) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const message = getFeishuMessage(db, messageId);
    if (message) return message;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return null;
}

function recoverMessageFromCardContent(db, event, config) {
  if (event.operator_id !== config.feishu?.userId || typeof event.card_content !== 'string') return null;
  const id = event.card_content.match(/(?:RateLimitResetCredit_[A-Za-z0-9]+|manual:[0-9a-f-]{36})/)?.[0]
    || event.card_content.match(/卡片编号\s*[:：]?\s*([A-Za-z0-9_:-]+)/)?.[1];
  if (!id) return null;
  const card = getCard(db, id);
  if (!card) return null;
  const daysMatch = event.card_content.match(/(\d+)\s*天(?:后到期|天后)/);
  const thresholdDays = daysMatch ? Number(daysMatch[1]) : 7;
  recordFeishuMessage(db, { messageId: event.message_id, cardId: card.id,
    expiresAt: card.expiresAt, thresholdDays, recipientOpenId: event.operator_id });
  return getFeishuMessage(db, event.message_id);
}

export async function handleCardAction(event, config, { db = openStore(),
  refreshStatus = refreshCreditStatus, update = updateFeishuCard,
  patch = patchFeishuCard, consume = consumeCredit, closeDb = true } = {}) {
  try {
    const parsed = parseCardAction(event);
    if (!parsed || !event.event_id || !event.message_id || !event.operator_id || !event.token) return 'ignored';
    const message = (await waitForFeishuMessage(db, event.message_id))
      || recoverMessageFromCardContent(db, event, config);
    if (!message || message.recipientOpenId !== event.operator_id) return 'unauthorized';
    let card = getCard(db, message.cardId);
    const updateCard = async (state, notice = null, statusInfo = null, display = {}) => {
      if (!card) return;
      const options = { currentAvailableCount: latestCompleteSync(db)?.availableCount ?? null, ...display };
      try {
        await update(config, event.token, card, message.thresholdDays, state,
          null, notice, statusInfo, options);
      } catch {
        await patch(config, message.messageId, card, message.thresholdDays, state,
          null, notice, statusInfo, options);
      }
    };

    if (card?.status === 'used' && card.expiresAt === message.expiresAt) {
      let statusInfo = null;
      if (parsed.action === 'refresh' && isOfficialCodexCard(card)) {
        try { statusInfo = await refreshStatus(); } catch { /* Keep the confirmed state. */ }
      }
      setFeishuMessageStatus(db, message.messageId, 'used');
      await updateCard('used', isOfficialCodexCard(card)
        ? 'Codex 已确认该卡不再可用，后续到期提醒已停止。'
        : '手动卡片已在本地标记为已使用。', statusInfo);
      return parsed.action === 'refresh' ? 'refreshed' : 'already_used';
    }
    if (!card || card.expiresAt !== message.expiresAt || card.status !== 'available'
      || card.expiresAt <= Date.now() / 1000) {
      if (card) await updateCard('unavailable');
      return 'unavailable';
    }

    if (parsed.action === 'refresh') {
      if (!isOfficialCodexCard(card) || !card.reportedUsedAt) return 'ignored';
      let statusInfo = null;
      let refreshError = false;
      try { statusInfo = await refreshStatus(); } catch { refreshError = true; }
      card = getCard(db, card.id);
      if (card.status === 'used') {
        setFeishuMessageStatus(db, message.messageId, 'used');
        await updateCard('used', 'Codex 已确认该卡不再可用，后续到期提醒已停止。', statusInfo);
        return 'confirmed_used';
      }
      if (card.status !== 'available') {
        setFeishuMessageStatus(db, message.messageId, 'unavailable');
        await updateCard('unavailable', 'Codex 已不再列出这张卡；未观察到对应的可用数量下降。');
        return 'unavailable';
      }
      await updateCard('pending_verification', refreshError
        ? '这次未能读取 Codex；已保留反馈，稍后会继续核实。'
        : 'Codex 最近同步仍显示这张卡可用；后续提前提醒会保留。', statusInfo);
      return 'pending_verification';
    }

    if (parsed.action === 'consume') {
      if (!isOfficialCodexCard(card) || card.reportedUsedAt) return 'ignored';
      const key = randomUUID();
      if (!claimCardActionEvent(db, event.event_id, event.message_id, `consume:${key}`)) return 'duplicate';
      let result;
      try { result = await consume(card.id, key); }
      catch {
        card = getCard(db, card.id);
        if (card?.status === 'used') {
          setFeishuMessageStatus(db, message.messageId, 'used');
          completeCardActionEvent(db, event.event_id, 'used_codex');
          await updateCard('used', 'Codex 已确认用卡成功，后续到期提醒已停止。');
          return 'used_codex';
        }
        card = reportCardUsed(db, card.id);
        setFeishuMessageStatus(db, message.messageId, 'pending_verification');
        completeCardActionEvent(db, event.event_id, 'consume_uncertain');
        await updateCard('pending_verification', 'Codex 用卡请求的结果尚未确认；稍后会自动核实。请勿连续点击历史消息。');
        return 'consume_uncertain';
      }
      if (result.outcome === 'reset' || result.outcome === 'alreadyRedeemed') {
        card = getCard(db, card.id);
        setFeishuMessageStatus(db, message.messageId, 'used');
        completeCardActionEvent(db, event.event_id, `used_codex:${result.outcome}`);
        await updateCard('used', 'Codex 已确认用卡成功，后续到期提醒已停止。', result.statusInfo);
        return `used_codex:${result.outcome}`;
      }
      if (result.outcome === 'noCredit') {
        let statusInfo = null;
        try { statusInfo = await refreshStatus(); } catch { /* Keep the local card until a complete sync. */ }
        card = getCard(db, card.id);
        if (card?.status !== 'available') {
          setFeishuMessageStatus(db, message.messageId, 'unavailable');
          completeCardActionEvent(db, event.event_id, 'no_credit');
          await updateCard('unavailable', 'Codex 返回没有可用重置卡；这张卡已不在可用列表。', statusInfo);
          return 'no_credit';
        }
      }
      completeCardActionEvent(db, event.event_id, result.outcome);
      await updateCard('available', result.outcome === 'nothingToReset'
        ? '当前没有符合条件的用量窗口可以重置；这张卡未被消耗。'
        : 'Codex 返回没有可用重置卡；本地仍显示可用，请核对 Codex Usage。');
      return result.outcome;
    }

    if (parsed.action === 'use') {
      if (card.reportedUsedAt && isOfficialCodexCard(card)) {
        await updateCard('pending_verification', '已记录使用反馈；最早 10 分钟后自动读取 Codex 核实。');
        return 'already_pending';
      }
      if (!claimCardActionEvent(db, event.event_id, event.message_id, 'use')) return 'duplicate';
      if (isOfficialCodexCard(card)) {
        card = reportCardUsed(db, card.id);
        setFeishuMessageStatus(db, message.messageId, 'pending_verification');
        completeCardActionEvent(db, event.event_id, 'pending_verification');
        await updateCard('pending_verification', '已记录使用反馈；未调用 Codex 用卡。最早 10 分钟后自动核实。');
        return 'pending_verification';
      }
      markCardUsed(db, card.id);
      card = getCard(db, card.id);
      setFeishuMessageStatus(db, message.messageId, 'used');
      completeCardActionEvent(db, event.event_id, 'used_local');
      await updateCard('used', '手动卡片已在本地标记为已使用。');
      return 'used_local';
    }

    if (parsed.action === 'later') {
      if (message.actionStatus === 'snoozed') {
        await updateCard('snoozed', null, null, { snoozeTargetAt: getSnooze(db, card.id)?.targetAt });
        return 'already_snoozed';
      }
      if (!getSnoozeOptions(card).length) {
        await updateCard('available', '距离到期时间太近，三个固定延期选项都已不可用。');
        return 'no_snooze_options';
      }
      if (!claimCardActionEvent(db, event.event_id, event.message_id, 'later')) return 'duplicate';
      setFeishuMessageStatus(db, message.messageId, 'choosing');
      completeCardActionEvent(db, event.event_id, 'choosing');
      await updateCard('choosing');
      return 'choosing';
    }

    if (parsed.action === 'snooze') {
      if (message.actionStatus === 'snoozed') {
        await updateCard('snoozed', null, null, { snoozeTargetAt: getSnooze(db, card.id)?.targetAt });
        return 'already_snoozed';
      }
      if (message.actionStatus !== 'choosing') return 'ignored';
      let plan;
      try { plan = planSnooze(card, parsed.option); }
      catch {
        await updateCard('available', '所选延期时间已过或晚于到期时间，请重新选择。');
        return 'invalid_snooze_time';
      }
      if (!claimCardActionEvent(db, event.event_id, event.message_id, `snooze:${parsed.option}`)) return 'duplicate';
      scheduleSnooze(db, card.id, card.expiresAt, plan.targetAt);
      setFeishuMessageStatus(db, message.messageId, 'snoozed');
      completeCardActionEvent(db, event.event_id, `snoozed:${parsed.option}`);
      await updateCard('snoozed', `将在${plan.label}提醒，官方到期时间不变。`, null,
        { snoozeTargetAt: plan.targetAt });
      return `snoozed:${parsed.option}`;
    }
    return 'ignored';
  } finally { if (closeDb) db.close(); }
}
