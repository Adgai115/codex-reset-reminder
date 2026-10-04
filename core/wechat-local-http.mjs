import { open } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

export const LOCAL_WECHAT_INPUT_LIMIT = 16384;
export const LOCAL_WECHAT_RESPONSE_LIMIT = 16384;
export const LOCAL_WECHAT_REQUEST_TIMEOUT = 75000;
const idPattern = /^[A-Za-z0-9._:-]{1,128}$/;
const resultStates = new Set(['accepted', 'unknown', 'rejected', 'unsent', 'pending']);
const publicCodes = new Set([
  'WECHAT_LOCAL_INVALID', 'WECHAT_LOCAL_UNAUTHORIZED', 'WECHAT_LOCAL_ORIGIN',
  'WECHAT_LOCAL_HOST', 'WECHAT_LOCAL_METHOD', 'WECHAT_LOCAL_NOT_FOUND',
  'WECHAT_LOCAL_TOO_LARGE', 'WECHAT_LOCAL_CONFLICT', 'WECHAT_LOCAL_BUSY',
  'WECHAT_LOCAL_COOLDOWN', 'WECHAT_LOCAL_CAPACITY', 'WECHAT_LOCAL_STORAGE',
  'WECHAT_LOCAL_OFFLINE', 'WECHAT_LOCAL_REVOKED', 'WECHAT_LOCAL_UNSENT',
  'WECHAT_LOCAL_STATUS', 'WECHAT_LOCAL_CONFIGURATION', 'WECHAT_LOCAL_CREDENTIALS',
  'WECHAT_LOCAL_HELPER_UNAVAILABLE', 'WECHAT_LOCAL_CANCELLED',
  'WECHAT_ACCEPTED', 'WECHAT_UNKNOWN', 'WECHAT_REJECTED',
  'WECHAT_SESSION_EXPIRED', 'WECHAT_CANCELLED', 'WECHAT_LOCAL_PENDING',
]);
const provenUnsentCodes = new Set([...publicCodes].filter((code) => code.startsWith('WECHAT_LOCAL_')
  && !['WECHAT_LOCAL_PENDING', 'WECHAT_LOCAL_STATUS'].includes(code)));

export function localWechatFailure(code, request) {
  return { ...(typeof request?.id === 'string' && idPattern.test(request.id) ? { id: request.id } : {}),
    state: code === 'WECHAT_UNKNOWN' ? 'unknown' : 'unsent', code,
    ...(code === 'WECHAT_UNKNOWN' ? {} : { unsent: true }) };
}

export function validLocalWechatRequest(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === 3 && Object.keys(value).every((key) => ['id', 'title', 'text'].includes(key))
    && typeof value.id === 'string' && idPattern.test(value.id)
    && typeof value.title === 'string' && value.title.trim().length > 0 && value.title.length <= 100
    && typeof value.text === 'string' && value.text.trim().length > 0 && value.text.length <= 4000
    && Buffer.byteLength(`${value.title}\n${value.text}`, 'utf8') <= 8192
    && Buffer.byteLength(JSON.stringify(value), 'utf8') <= LOCAL_WECHAT_INPUT_LIMIT;
}

export function validLocalWechatClient(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && value.version === 1 && value.kind === 'wechat-local-client'
    && typeof value.clientId === 'string' && idPattern.test(value.clientId)
    && typeof value.token === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value.token)
    && typeof value.discoveryPath === 'string' && isAbsolute(value.discoveryPath);
}

export function validateLocalWechatEndpoint(value) {
  if (typeof value !== 'string') return null;
  const match = /^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})$/.exec(value);
  if (!match || Number(match[1]) > 65535) return null;
  return value;
}

// File reads are bounded before allocation, including files replaced mid-read.
export async function readLimitedLocalFile(path, limit) {
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(limit + 1);
    let length = 0;
    while (length <= limit) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
      if (!bytesRead) return buffer.subarray(0, length);
      length += bytesRead;
    }
    throw new Error('LOCAL_FILE_TOO_LARGE');
  } finally { await handle.close(); }
}

function publicReceipt(value, expectedId) {
  if (!value || !resultStates.has(value.state) || !idPattern.test(value.id || '')
    || (expectedId && value.id !== expectedId) || !publicCodes.has(value.code)) return null;
  if ((value.state === 'accepted' && value.code !== 'WECHAT_ACCEPTED')
    || (value.state === 'pending' && value.code !== 'WECHAT_LOCAL_PENDING')
    || (value.state === 'unknown' && value.code !== 'WECHAT_UNKNOWN')
    || (value.state === 'unsent' && !provenUnsentCodes.has(value.code))) return null;
  const result = { id: value.id, state: value.state, code: value.state === 'unknown' ? 'WECHAT_UNKNOWN' : value.code };
  if (typeof value.at === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value.at)
    && Number.isFinite(Date.parse(value.at))) result.at = value.at;
  if (value.state === 'unsent') result.unsent = true;
  return result;
}

// No server text, credentials, endpoint, cursor, or provider details cross back.
export function sanitizeLocalWechatResult(value, { request, mode = 'notify' } = {}) {
  if (mode !== 'status') {
    if (value?.state === 'unsent' && provenUnsentCodes.has(value.code)
      && (!value.id || value.id === request?.id)) return localWechatFailure(value.code, request);
    return publicReceipt(value, request?.id);
  }
  if (value?.state !== 'status' || value.code !== 'WECHAT_LOCAL_STATUS') {
    return value?.state === 'unsent' && provenUnsentCodes.has(value.code) ? localWechatFailure(value.code) : null;
  }
  if (typeof value.running !== 'boolean' || !Number.isInteger(value.queued) || value.queued < 0
    || value.queued > 1000 || typeof value.sending !== 'boolean') return null;
  const result = { state: 'status', code: 'WECHAT_LOCAL_STATUS',
    running: value.running, queued: value.queued, sending: value.sending };
  if (value.client && idPattern.test(value.client.id || '') && typeof value.client.label === 'string'
    && value.client.label.length <= 100) result.client = { id: value.client.id, label: value.client.label };
  if (Array.isArray(value.receipts)) result.receipts = value.receipts.slice(0, 100)
    .map((receipt) => publicReceipt(receipt)).filter(Boolean);
  if (value.capacity && ['clients', 'receipts'].every((key) => Number.isInteger(value.capacity[key])
    && value.capacity[key] >= 0 && value.capacity[key] <= 100000))
    result.capacity = { clients: value.capacity.clients, receipts: value.capacity.receipts };
  return result;
}

async function readResponse(response) {
  const declared = response.headers?.get?.('content-length');
  if (declared && (/[^0-9]/.test(declared) || Number(declared) > LOCAL_WECHAT_RESPONSE_LIMIT))
    throw new Error('LOCAL_RESPONSE_TOO_LARGE');
  if (!response.body?.getReader) {
    const value = await response.text();
    if (Buffer.byteLength(value, 'utf8') > LOCAL_WECHAT_RESPONSE_LIMIT) throw new Error('LOCAL_RESPONSE_TOO_LARGE');
    return JSON.parse(value);
  }
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > LOCAL_WECHAT_RESPONSE_LIMIT) throw new Error('LOCAL_RESPONSE_TOO_LARGE');
      chunks.push(Buffer.from(value));
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, length)));
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally { reader.releaseLock(); }
}

export async function requestLocalWechatNotification(client, request, {
  fetchImpl = globalThis.fetch, timeoutMs = LOCAL_WECHAT_REQUEST_TIMEOUT, signal,
  mode = 'notify', discovery, readFileImpl = readLimitedLocalFile,
} = {}) {
  if (!validLocalWechatClient(client) || !['notify', 'status'].includes(mode)
    || (mode === 'notify' && !validLocalWechatRequest(request)))
    return localWechatFailure('WECHAT_LOCAL_CONFIGURATION', request);
  if (signal?.aborted) return localWechatFailure('WECHAT_LOCAL_CANCELLED', request);
  let record = discovery;
  try {
    if (!record) record = JSON.parse((await readFileImpl(client.discoveryPath, 2048)).toString('utf8'));
  } catch { return localWechatFailure('WECHAT_LOCAL_OFFLINE', request); }
  if (signal?.aborted) return localWechatFailure('WECHAT_LOCAL_CANCELLED', request);
  const endpoint = record?.version === 1 && validateLocalWechatEndpoint(record.endpoint);
  if (!endpoint) return localWechatFailure('WECHAT_LOCAL_CONFIGURATION', request);
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  const timeout = setTimeout(abort, Number.isFinite(timeoutMs) ? Math.max(1, Math.min(timeoutMs, 90000)) : LOCAL_WECHAT_REQUEST_TIMEOUT);
  let onAbort;
  const aborted = new Promise((_, reject) => {
    onAbort = () => reject(new Error('LOCAL_REQUEST_ABORTED'));
    controller.signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    // Cancellation during discovery or listener registration is still proved
    // unsent. Once fetch begins, retain the conservative unknown result.
    if (signal?.aborted || controller.signal.aborted)
      return localWechatFailure('WECHAT_LOCAL_CANCELLED', request);
    const operation = (async () => {
      const response = await fetchImpl(`${endpoint}/v1/${mode === 'status' ? 'status' : 'notify'}`, {
        method: mode === 'status' ? 'GET' : 'POST', redirect: 'error', signal: controller.signal,
        headers: { Authorization: `Bearer ${client.token}`, ...(mode === 'notify' ? { 'Content-Type': 'application/json' } : {}) },
        ...(mode === 'notify' ? { body: JSON.stringify(request) } : {}),
      });
      const raw = await readResponse(response);
      const result = sanitizeLocalWechatResult(raw, { request, mode });
      if (!result || (!response.ok && !['unsent', 'rejected'].includes(result.state))) throw new Error('LOCAL_RESPONSE_INVALID');
      return result;
    })();
    return await Promise.race([operation, aborted]);
  } catch (error) {
    // A refused TCP connection proves that no local gateway accepted this call.
    if (error?.code === 'ECONNREFUSED' || error?.cause?.code === 'ECONNREFUSED')
      return localWechatFailure('WECHAT_LOCAL_OFFLINE', request);
    return localWechatFailure(mode === 'status' ? 'WECHAT_LOCAL_OFFLINE' : 'WECHAT_UNKNOWN', request);
  } finally {
    clearTimeout(timeout);
    controller.signal.removeEventListener('abort', onAbort);
    signal?.removeEventListener('abort', abort);
  }
}
