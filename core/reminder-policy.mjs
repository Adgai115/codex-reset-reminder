// Keep delivery policy separate from account access and channel credentials.
// A future account selector can reuse this policy without changing reminder timing.
export const channelNames = ['desktop', 'feishu', 'wechat'];

export function enabledChannels(config = {}) {
  return channelNames.filter((name) => name === 'desktop'
    ? config.desktop?.enabled !== false
    : config[name]?.enabled === true);
}

export function quietHours(config = {}) {
  const value = config.reminders?.quietHours;
  if (!value?.enabled) return null;
  const parse = (clock) => {
    if (typeof clock !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(clock)) {
      throw new Error('免打扰时间必须使用 HH:mm 格式');
    }
    const [hour, minute] = clock.split(':').map(Number);
    return hour * 60 + minute;
  };
  const start = parse(value.start);
  const end = parse(value.end);
  if (start === end) throw new Error('免打扰开始和结束时间不能相同');
  return { start, end };
}

export function deliveryTime(targetAt, expiresAt, quiet = null) {
  if (!quiet || targetAt >= expiresAt) return targetAt;
  const date = new Date(targetAt * 1000);
  const minuteOfDay = date.getHours() * 60 + date.getMinutes();
  const overnight = quiet.start > quiet.end;
  const within = overnight
    ? minuteOfDay >= quiet.start || minuteOfDay < quiet.end
    : minuteOfDay >= quiet.start && minuteOfDay < quiet.end;
  if (!within) return targetAt;
  const end = new Date(date);
  end.setHours(Math.floor(quiet.end / 60), quiet.end % 60, 0, 0);
  if (overnight && minuteOfDay >= quiet.start) end.setDate(end.getDate() + 1);
  const deferredAt = Math.floor(end.getTime() / 1000);
  // Never defer a reminder until after the card has expired.
  return deferredAt < expiresAt ? deferredAt : targetAt;
}
