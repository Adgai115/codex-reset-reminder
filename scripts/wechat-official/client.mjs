import { randomBytes, randomUUID } from 'node:crypto';

// This is an isolated protocol probe, not a delivery guarantee. The public
// Tencent 2.4.9 client does not document server-side proactive-message limits.
export const DEFAULT_BASE_URL = 'https://ilinkai.weixin.qq.com';
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_VALUE_BYTES = 16384;
const MAX_TEXT_BYTES = 8192;
const QR_STATUSES = new Set(['wait', 'scaned', 'confirmed', 'expired',
  'need_verifycode', 'verify_code_blocked', 'scaned_but_redirect', 'binded_redirect']);
const messages = {
  WECHAT_CONFIGURATION: '微信官方验证参数无效。',
  WECHAT_REJECTED: '微信官方接口拒绝了请求。',
  WECHAT_SESSION_EXPIRED: '微信官方登录会话已失效，请重新扫码连接。',
  WECHAT_HTTP: '微信官方接口返回了异常 HTTP 状态。',
  WECHAT_PROTOCOL: '微信官方接口响应格式无效。',
  WECHAT_NETWORK: '无法连接微信官方接口。',
  WECHAT_TIMEOUT: '微信官方请求超时。',
  WECHAT_CANCELLED: '微信官方请求已取消。',
  WECHAT_UNKNOWN: '微信提交结果未知；服务端可能已接收，请先在手机核对，勿立即重复发送。',
};

function failure(code, details = {}) {
  const error = new Error(messages[code]);
  error.code = code;
  // Only fixed categories and numeric codes may cross the error boundary.
  for (const key of ['httpStatus', 'businessCode']) {
    if (Number.isSafeInteger(details[key])) error[key] = details[key];
  }
  return error;
}

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validString(value, { maxBytes = MAX_VALUE_BYTES, empty = false, token = false } = {}) {
  return typeof value === 'string' && (empty || value.length > 0)
    && Buffer.byteLength(value, 'utf8') <= maxBytes
    && !(token ? /[\s\u0000-\u001f\u007f]/ : /[\u0000\u007f]/).test(value);
}

function officialUrl(value, baseOnly = false) {
  if (typeof value !== 'string' || value.length > MAX_VALUE_BYTES
    || /[\s\u0000-\u001f\u007f\\]/.test(value)
    || (baseOnly && !/^https:\/\/[^/?#]+\/?$/i.test(value))) {
    throw failure('WECHAT_CONFIGURATION');
  }
  let parsed;
  try { parsed = new URL(value); } catch { throw failure('WECHAT_CONFIGURATION'); }
  const host = parsed.hostname.toLowerCase();
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password
    || (parsed.port && parsed.port !== '443')
    || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*weixin\.qq\.com$/.test(host)
    || (baseOnly && (parsed.pathname !== '/' || parsed.search || parsed.hash))) {
    throw failure('WECHAT_CONFIGURATION');
  }
  return parsed;
}

/** Validate API origins before any credential is attached. No path or query. */
export function safeWechatBaseUrl(value) {
  return officialUrl(value, true).origin;
}

function safeRedirectBaseUrl(value) {
  if (typeof value !== 'string' || !value) throw failure('WECHAT_CONFIGURATION');
  return safeWechatBaseUrl(value.includes('://') ? value : `https://${value}`);
}

function validatedSession(session) {
  if (!record(session) || !validString(session.token, { maxBytes: 8192, token: true })
    || !validString(session.userId, { maxBytes: 512, token: true })) {
    throw failure('WECHAT_CONFIGURATION');
  }
  return { token: session.token, userId: session.userId,
    baseUrl: safeWechatBaseUrl(session.baseUrl) };
}

function cancelBody(response) {
  try { Promise.resolve(response?.body?.cancel?.()).catch(() => {}); } catch {}
}

// Wire message IDs are uint64. Quote only integer values of actual JSON
// properties before parsing, so a numeric ID cannot invalidate an update or
// lose precision. Text containing JSON-looking snippets remains untouched.
function parseWireJson(source) {
  const pieces = [];
  let copiedUntil = 0;
  let index = 0;
  while (index < source.length) {
    if (source[index] !== '"') { index += 1; continue; }
    const start = index++;
    let escaped = false;
    while (index < source.length) {
      const character = source[index++];
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') break;
    }
    let key;
    try { key = JSON.parse(source.slice(start, index)); } catch { continue; }
    if (!['message_id', 'msg_id', 'svr_id'].includes(key)) continue;
    let cursor = index;
    while (/\s/.test(source[cursor] ?? '')) cursor += 1;
    if (source[cursor++] !== ':') continue;
    while (/\s/.test(source[cursor] ?? '')) cursor += 1;
    const numberStart = cursor;
    if (source[cursor] === '-') cursor += 1;
    const digitStart = cursor;
    while (/\d/.test(source[cursor] ?? '')) cursor += 1;
    if (cursor === digitStart || /[.eE]/.test(source[cursor] ?? '')) continue;
    pieces.push(source.slice(copiedUntil, numberStart), JSON.stringify(source.slice(numberStart, cursor)));
    copiedUntil = cursor;
    index = cursor;
  }
  pieces.push(source.slice(copiedUntil));
  return JSON.parse(pieces.join(''));
}

async function readBoundedJson(response) {
  if (!response || !Number.isInteger(response.status) || typeof response.ok !== 'boolean') {
    throw failure('WECHAT_PROTOCOL');
  }
  const declaredLength = response.headers?.get?.('content-length');
  if (declaredLength !== null && declaredLength !== undefined
    && /^\d+$/.test(declaredLength) && Number(declaredLength) > MAX_RESPONSE_BYTES) {
    cancelBody(response);
    throw failure('WECHAT_PROTOCOL');
  }
  let source;
  if (response.body?.getReader) {
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!(value instanceof Uint8Array)) throw failure('WECHAT_PROTOCOL');
        size += value.byteLength;
        if (size > MAX_RESPONSE_BYTES) {
          Promise.resolve(reader.cancel()).catch(() => {});
          throw failure('WECHAT_PROTOCOL');
        }
        chunks.push(Buffer.from(value));
      }
      source = Buffer.concat(chunks, size).toString('utf8');
    } finally {
      try { reader.releaseLock(); } catch {}
    }
  } else if (typeof response.text === 'function') {
    // Native fetch responses use the bounded streaming path above. This branch
    // also permits small test transports without retaining an error body.
    source = await response.text();
    if (typeof source !== 'string' || Buffer.byteLength(source, 'utf8') > MAX_RESPONSE_BYTES) {
      throw failure('WECHAT_PROTOCOL');
    }
  } else {
    throw failure('WECHAT_PROTOCOL');
  }
  let result;
  try { result = parseWireJson(source); } catch { throw failure('WECHAT_PROTOCOL'); }
  if (!record(result)) throw failure('WECHAT_PROTOCOL');
  return result;
}

function checkBusiness(result, { required = true, send = false } = {}) {
  const hasRet = Object.hasOwn(result, 'ret');
  const hasError = Object.hasOwn(result, 'errcode');
  for (const key of ['ret', 'errcode']) {
    if (Object.hasOwn(result, key)
      && (!Number.isSafeInteger(result[key]) || result[key] < -2147483648 || result[key] > 2147483647)) {
      throw failure(send ? 'WECHAT_UNKNOWN' : 'WECHAT_PROTOCOL');
    }
  }
  if (result.ret === -14 || result.errcode === -14) throw failure('WECHAT_SESSION_EXPIRED', { businessCode: -14 });
  const rejection = hasRet && result.ret !== 0 ? result.ret
    : hasError && result.errcode !== 0 ? result.errcode : undefined;
  if (rejection !== undefined) throw failure('WECHAT_REJECTED', { businessCode: rejection });
  if (required && !hasRet) throw failure(send ? 'WECHAT_UNKNOWN' : 'WECHAT_PROTOCOL');
}

/** All methods perform one request. The caller owns any read-only polling. */
export function createWechatClient({ fetchImpl = globalThis.fetch, timeoutMs = 15000,
  longPollTimeoutMs = 35000, version = '2.4.9' } = {}) {
  const versionParts = typeof version === 'string' && /^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(version)
    ? version.split('.').map(Number) : [];
  if (typeof fetchImpl !== 'function' || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000
    || !Number.isInteger(longPollTimeoutMs) || longPollTimeoutMs < 1 || longPollTimeoutMs > 60000
    || versionParts.length !== 3 || versionParts.some(part => part > 255)) {
    throw failure('WECHAT_CONFIGURATION');
  }
  const clientVersion = (versionParts[0] << 16) | (versionParts[1] << 8) | versionParts[2];
  const baseInfo = { channel_version: version, bot_agent: 'CodexResetReminderProbe/1.0' };

  async function request({ baseUrl = DEFAULT_BASE_URL, path, method = 'POST', token, body, signal,
    send = false, requestTimeoutMs = timeoutMs }) {
    const origin = safeWechatBaseUrl(baseUrl);
    if (signal !== undefined && (!signal || typeof signal.addEventListener !== 'function')) {
      throw failure('WECHAT_CONFIGURATION');
    }
    if (signal?.aborted) throw failure('WECHAT_CANCELLED');
    const controller = new AbortController();
    let abortKind;
    let dispatched = false;
    let response;
    let rejectAbort;
    const aborted = new Promise((_, reject) => { rejectAbort = reject; });
    const abort = kind => {
      if (abortKind) return;
      abortKind = kind;
      controller.abort();
      cancelBody(response);
      rejectAbort(failure(kind === 'timeout' ? 'WECHAT_TIMEOUT' : 'WECHAT_CANCELLED'));
    };
    const onExternalAbort = () => abort('cancelled');
    signal?.addEventListener('abort', onExternalAbort, { once: true });
    const timer = setTimeout(() => abort('timeout'), requestTimeoutMs);
    const headers = { 'iLink-App-Id': 'bot', 'iLink-App-ClientVersion': String(clientVersion) };
    if (method === 'POST') {
      headers['Content-Type'] = 'application/json';
      headers.AuthorizationType = 'ilink_bot_token';
      headers['X-WECHAT-UIN'] = Buffer.from(String(randomBytes(4).readUInt32BE(0)), 'utf8').toString('base64');
      if (token) headers.Authorization = `Bearer ${token}`;
    }
    const operation = async () => {
      if (abortKind || signal?.aborted) throw failure('WECHAT_CANCELLED');
      dispatched = true;
      response = await fetchImpl(new URL(path, `${origin}/`).toString(), {
        method, headers, redirect: 'error', signal: controller.signal,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      if (!response || !Number.isInteger(response.status) || typeof response.ok !== 'boolean') {
        throw failure('WECHAT_PROTOCOL');
      }
      if (!response.ok || response.status < 200 || response.status >= 300) {
        cancelBody(response);
        throw failure('WECHAT_HTTP', { httpStatus: response.status });
      }
      return readBoundedJson(response);
    };
    try {
      return await Promise.race([operation(), aborted]);
    } catch (error) {
      if (send && dispatched) throw failure('WECHAT_UNKNOWN', { httpStatus: error?.httpStatus });
      if (abortKind) throw failure(abortKind === 'timeout' ? 'WECHAT_TIMEOUT' : 'WECHAT_CANCELLED');
      if (error?.code === 'WECHAT_HTTP' || error?.code === 'WECHAT_PROTOCOL') throw error;
      throw failure('WECHAT_NETWORK');
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onExternalAbort);
    }
  }

  return {
    async requestQr({ signal } = {}) {
      const result = await request({ path: 'ilink/bot/get_bot_qrcode?bot_type=3',
        body: { local_token_list: [] }, signal });
      checkBusiness(result, { required: false });
      if (!validString(result.qrcode) || !validString(result.qrcode_img_content)) {
        throw failure('WECHAT_PROTOCOL');
      }
      let qrUrl;
      try { qrUrl = officialUrl(result.qrcode_img_content).toString(); }
      catch { throw failure('WECHAT_PROTOCOL'); }
      return { qrcode: result.qrcode, qrcode_img_content: qrUrl };
    },

    async pollQr(qrcode, { baseUrl = DEFAULT_BASE_URL, verifyCode, signal } = {}) {
      if (!validString(qrcode) || (verifyCode !== undefined
        && !validString(verifyCode, { maxBytes: 64, token: true }))) {
        throw failure('WECHAT_CONFIGURATION');
      }
      const params = new URLSearchParams({ qrcode });
      if (verifyCode !== undefined) params.set('verify_code', verifyCode);
      let result;
      try {
        result = await request({ baseUrl, path: `ilink/bot/get_qrcode_status?${params}`,
          method: 'GET', signal, requestTimeoutMs: longPollTimeoutMs });
      } catch (error) {
        if (signal?.aborted) throw failure('WECHAT_CANCELLED');
        if (error?.code === 'WECHAT_TIMEOUT') return { status: 'wait' };
        throw error;
      }
      checkBusiness(result, { required: false });
      if (!QR_STATUSES.has(result.status)) throw failure('WECHAT_PROTOCOL');
      const validated = { ...result };
      try {
        if (result.baseurl !== undefined) validated.baseurl = safeWechatBaseUrl(result.baseurl);
        if (result.redirect_host !== undefined) validated.redirectBaseUrl = safeRedirectBaseUrl(result.redirect_host);
      } catch { throw failure('WECHAT_PROTOCOL'); }
      if (result.status === 'scaned_but_redirect' && !validated.redirectBaseUrl) throw failure('WECHAT_PROTOCOL');
      if (result.status === 'confirmed' && (!validString(result.bot_token, { maxBytes: 8192, token: true })
        || !validString(result.ilink_user_id, { maxBytes: 512, token: true }) || !validated.baseurl)) {
        throw failure('WECHAT_PROTOCOL');
      }
      return validated;
    },

    async getUpdates(session, { cursor = '', signal } = {}) {
      const current = validatedSession(session);
      if (!validString(cursor, { maxBytes: 131072, empty: true })) throw failure('WECHAT_CONFIGURATION');
      let result;
      try {
        result = await request({ ...current, path: 'ilink/bot/getupdates',
          body: { get_updates_buf: cursor, base_info: baseInfo }, signal,
          requestTimeoutMs: longPollTimeoutMs });
      } catch (error) {
        if (signal?.aborted) throw failure('WECHAT_CANCELLED');
        if (error?.code === 'WECHAT_TIMEOUT') return { ret: 0, msgs: [], get_updates_buf: cursor };
        throw error;
      }
      checkBusiness(result);
      if (!Array.isArray(result.msgs) || result.msgs.length > 1000 || !result.msgs.every(record)
        || (result.get_updates_buf !== undefined
          && !validString(result.get_updates_buf, { maxBytes: 131072, empty: true }))) {
        throw failure('WECHAT_PROTOCOL');
      }
      // Keep only text and conversation metadata. No media URL is fetched or
      // carried to callers, and received content is never written by this module.
      const msgs = result.msgs.map(msg => {
        const keep = {};
        for (const key of ['from_user_id', 'to_user_id', 'context_token', 'message_id']) {
          if (msg[key] === undefined) continue;
          if (!validString(msg[key], { maxBytes: MAX_VALUE_BYTES })) throw failure('WECHAT_PROTOCOL');
          keep[key] = msg[key];
        }
        for (const key of ['create_time_ms', 'message_type', 'message_state']) {
          if (Number.isSafeInteger(msg[key])) keep[key] = msg[key];
        }
        if (Array.isArray(msg.item_list)) {
          keep.item_list = msg.item_list.filter(item => record(item) && item.type === 1
            && record(item.text_item) && validString(item.text_item.text, { empty: true }))
            .map(item => ({ type: 1, text_item: { text: item.text_item.text } }));
        }
        return keep;
      });
      return { ret: 0, msgs, get_updates_buf: result.get_updates_buf ?? cursor,
        ...(Number.isSafeInteger(result.longpolling_timeout_ms) && result.longpolling_timeout_ms > 0
          ? { longpolling_timeout_ms: result.longpolling_timeout_ms } : {}) };
    },

    async sendText(session, { text, contextToken, clientId = `codex-reset-reminder-${randomUUID()}`, signal } = {}) {
      const current = validatedSession(session);
      if (!validString(text, { maxBytes: MAX_TEXT_BYTES }) || !text.trim()
        || !validString(clientId, { maxBytes: 128, token: true })
        || (contextToken !== undefined && !validString(contextToken, { token: true }))) {
        throw failure('WECHAT_CONFIGURATION');
      }
      const result = await request({ ...current, path: 'ilink/bot/sendmessage', send: true, signal,
        body: { msg: { from_user_id: '', to_user_id: current.userId, client_id: clientId,
          message_type: 2, message_state: 2,
          ...(contextToken !== undefined ? { context_token: contextToken } : {}),
          item_list: [{ type: 1, text_item: { text } }] }, base_info: baseInfo } });
      checkBusiness(result, { send: true });
      return { ok: true, confirmation: 'accepted', clientId };
    },

    async notify(session, state, { signal } = {}) {
      const current = validatedSession(session);
      if (state !== 'start' && state !== 'stop') throw failure('WECHAT_CONFIGURATION');
      const result = await request({ ...current, path: `ilink/bot/msg/notify${state}`,
        body: { base_info: baseInfo }, signal });
      checkBusiness(result);
      return { ok: true };
    },
  };
}
