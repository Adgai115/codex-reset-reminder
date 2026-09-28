// 待处理是已发送记录的视图，不是已读回执。关闭窗口或打开 Codex 不会清除它。
// 使用现有持久化记录，重启、升级和旧版迁移都不需要复制一份提醒状态。
export function pendingReminder(card, snooze, results, nowSeconds = Math.floor(Date.now() / 1000)) {
  if (card.source !== 'codex' || card.status !== 'available' || card.expiresAt <= nowSeconds) return null;
  const currentSnooze = snooze?.expiresAt === card.expiresAt ? snooze : null;
  const sent = results.filter((result) => {
    if (result.state !== 'sent' || result.expiresAt !== card.expiresAt || result.nodeAt > nowSeconds) return false;
    if (result.nodeKind === 'snooze') {
      return currentSnooze?.targetAt === result.nodeAt
        && Boolean(currentSnooze[`${result.channel}DeliveredAt`]);
    }
    return !currentSnooze || currentSnooze.targetAt < result.nodeAt;
  }).sort((a, b) => b.nodeAt - a.nodeAt || b.attemptedAt - a.attemptedAt);
  if (!sent.length) return null;
  const latest = sent[0];
  return { nodeKind: latest.nodeKind, nodeAt: latest.nodeAt, thresholdDays: latest.thresholdDays,
    notifiedAt: Math.max(...sent.filter((item) => item.nodeAt === latest.nodeAt)
      .map((item) => item.succeededAt || item.attemptedAt)),
  };
}
