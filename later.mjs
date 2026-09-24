const choices = [
  { option: '1d', label: '1 天后', seconds: 86400 },
  { option: '3d', label: '3 天后', seconds: 3 * 86400 },
  { option: 'tomorrow10', label: '明天 10:00' },
];

function targetFor(option, nowSeconds) {
  if (option.seconds) return nowSeconds + option.seconds;
  const tomorrow = new Date(nowSeconds * 1000);
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(10, 0, 0, 0);
  return Math.floor(tomorrow.getTime() / 1000);
}

export function getSnoozeOptions(card, nowSeconds = Math.floor(Date.now() / 1000)) {
  if (!card || card.status !== 'available' || !Number.isInteger(card.expiresAt)) return [];
  return choices.map((choice) => ({ option: choice.option, label: choice.label,
    targetAt: targetFor(choice, nowSeconds) }))
    .filter((choice) => choice.targetAt > nowSeconds && choice.targetAt < card.expiresAt);
}

export function planSnooze(card, option, nowSeconds = Math.floor(Date.now() / 1000)) {
  const selected = getSnoozeOptions(card, nowSeconds).find((choice) => choice.option === option);
  if (!selected) throw new Error('这张卡片已无法延期到所选时间');
  return selected;
}
