// 首次发送后最多补发三次；总尝试次数为四次。
export const retryDelaysSeconds = [60, 300, 900];
export const maxReminderAttempts = retryDelaysSeconds.length + 1;

export function nextRetryAfter(attempts, attemptedAt) {
  const delay = retryDelaysSeconds[attempts - 1];
  return delay === undefined ? null : attemptedAt + delay;
}

export function mayAttemptReminder(attempt, nowSeconds, manual = false) {
  if (!attempt) return !manual;
  if (attempt.state === 'sent' || attempt.attempts >= maxReminderAttempts) return false;
  if (manual) return attempt.state === 'failed';
  return Number.isInteger(attempt.nextRetryAt) && attempt.nextRetryAt <= nowSeconds;
}
