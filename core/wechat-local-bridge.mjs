import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { validateLocalWechatEndpoint, validLocalWechatRequest, sanitizeLocalWechatResult } from './wechat-local-http.mjs';

// Windows Electron does not reliably expose inherited stdin. This one-call,
// authenticated loopback bridge transports input and the public result in RAM.
export async function createLocalClientBridge({ request, mode, onResult }) {
  const token = randomBytes(32).toString('base64url');
  let endpoint = '', inputClaimed = false, returned = false;
  const reply = (response, status, value) => {
    response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', Connection: 'close' });
    response.end(JSON.stringify(value));
  };
  const server = createServer(async (incoming, response) => {
    try {
      const authorization = incoming.headers.authorization;
      if (incoming.socket.remoteAddress !== '127.0.0.1' || Object.hasOwn(incoming.headers, 'origin')
        || incoming.headers.host !== endpoint.slice(7)
        || typeof authorization !== 'string' || !/^Bearer [A-Za-z0-9_-]{43}$/.test(authorization)
        || incoming.rawHeaders.filter((v, i) => i % 2 === 0 && ['authorization', 'host'].includes(v.toLowerCase())).length !== 2
        || !timingSafeEqual(Buffer.from(authorization.slice(7)), Buffer.from(token))) return reply(response, 403, {});
      if (incoming.method === 'GET' && incoming.url === '/input' && !inputClaimed) {
        inputClaimed = true;
        return reply(response, 200, { version: 1, mode, ...(mode === 'notify' ? { request } : {}) });
      }
      if (incoming.method !== 'POST' || incoming.url !== '/result' || !inputClaimed || returned
        || incoming.headers['content-type'] !== 'application/json') return reply(response, 400, {});
      const chunks = []; let length = 0;
      for await (const chunk of incoming) {
        length += chunk.length;
        if (length > 16384) return reply(response, 413, {});
        chunks.push(chunk);
      }
      const result = sanitizeLocalWechatResult(JSON.parse(Buffer.concat(chunks).toString('utf8')), { request, mode });
      if (!result) return reply(response, 400, {});
      returned = true;
      reply(response, 200, {});
      setImmediate(() => onResult(result));
    } catch { if (!response.headersSent) reply(response, 400, {}); else response.destroy(); }
  });
  server.requestTimeout = 10000; server.headersTimeout = 10000;
  server.keepAliveTimeout = 1000; server.maxHeadersCount = 16;
  server.on('clientError', (_error, socket) => socket.destroy());
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  server.on('error', () => {});
  endpoint = `http://127.0.0.1:${server.address().port}`;
  return { env: { CODEX_WECHAT_HELPER_BRIDGE: endpoint, CODEX_WECHAT_HELPER_KEY: token },
    async close() { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); },
  };
}

export function takeLocalClientBridge(environment) {
  const endpoint = validateLocalWechatEndpoint(environment.CODEX_WECHAT_HELPER_BRIDGE);
  const token = environment.CODEX_WECHAT_HELPER_KEY;
  delete environment.CODEX_WECHAT_HELPER_BRIDGE; delete environment.CODEX_WECHAT_HELPER_KEY;
  if (!endpoint || typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw new Error('LOCAL_BRIDGE_INVALID');
  return { endpoint, token };
}

export async function readLocalClientBridge(bridge) {
  const response = await fetch(`${bridge.endpoint}/input`, { redirect: 'error',
    headers: { Authorization: `Bearer ${bridge.token}` }, signal: AbortSignal.timeout(10000) });
  const text = await response.text();
  if (!response.ok || Buffer.byteLength(text) > 16384) throw new Error('LOCAL_BRIDGE_INVALID');
  const value = JSON.parse(text);
  if (value.version !== 1 || !['notify', 'status'].includes(value.mode)
    || (value.mode === 'notify' && !validLocalWechatRequest(value.request))) throw new Error('LOCAL_BRIDGE_INVALID');
  return value;
}

export async function returnLocalClientBridge(bridge, result) {
  const response = await fetch(`${bridge.endpoint}/result`, { method: 'POST', redirect: 'error',
    headers: { Authorization: `Bearer ${bridge.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(result), signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error('LOCAL_BRIDGE_INVALID');
  await response.text();
}
