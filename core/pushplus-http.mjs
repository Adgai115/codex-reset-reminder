const endpoint = 'https://www.pushplus.plus/send';
const rejectionCodes = new Set([302, 401, 403, 500, 600, 805, 888, 903, 905, 999]);

function failure(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export function pushplusUnknown() {
  return failure('PUSHPLUS_UNKNOWN', '微信提交结果未知；服务端可能已接收，已停止自动补发，请在 PushPlus 核对。');
}

// Only this transport sees the runtime credential. Neither the URL nor returned
// errors contain it, and redirects cannot carry it to another endpoint.
export async function requestPushplus(payload, { token, fetchImpl = globalThis.fetch, timeoutMs = 15000 } = {}) {
  if (typeof token !== 'string' || !token.trim() || token.length > 256 || /[\s\u0000-\u001f]/.test(token))
    throw failure('PUSHPLUS_CONFIGURATION', '微信 PushPlus 连接未配置或无效，请在“设置 → 提醒”中配置。');
  if (!payload || typeof payload.title !== 'string' || typeof payload.content !== 'string'
    || !payload.content || payload.template !== 'txt' || payload.channel !== 'wechat'
    || Object.keys(payload).some((key) => !['title', 'content', 'template', 'channel'].includes(key)))
    throw failure('PUSHPLUS_CONFIGURATION', '微信 PushPlus 消息配置无效。');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let response;
    let result;
    try {
      response = await fetchImpl(endpoint, { method: 'POST', redirect: 'error',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...payload, token }), signal: controller.signal });
      const text = await response.text();
      if (text.length > 16384) throw pushplusUnknown();
      result = JSON.parse(text);
    } catch { throw pushplusUnknown(); }
    // HTTP success alone is insufficient. A recognized business rejection is
    // safe to retry; everything else may already have queued a notification.
    if (result?.code === 900)
      throw failure('PUSHPLUS_LIMITED', '微信 PushPlus 账号受限；已停止自动补发，请在 PushPlus 核对并恢复后再试。');
    if (rejectionCodes.has(result?.code))
      throw failure('PUSHPLUS_REJECTED', '微信 PushPlus 拒绝提交；请检查连接、公众号关注及服务额度。');
    const messageId = result?.data;
    if (!response.ok || result?.code !== 200 || typeof messageId !== 'string'
      || !/^[a-z0-9_-]{1,128}$/i.test(messageId) || messageId.includes(token))
      throw pushplusUnknown();
    return { ok: true, confirmation: 'accepted', messageId };
  } finally { clearTimeout(timeout); }
}
