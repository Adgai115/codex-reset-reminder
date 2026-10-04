import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { requestLocalWechatNotification, sanitizeLocalWechatResult, validateLocalWechatEndpoint,
  validLocalWechatRequest, readLimitedLocalFile } from './wechat-local-http.mjs';

const client = { version: 1, kind: 'wechat-local-client', clientId: 'mock-agent', token: 'a'.repeat(43),
  discoveryPath: join(tmpdir(), 'synthetic-wechat-gateway.json') };
const discovery = { version: 1, endpoint: 'http://127.0.0.1:41234' };
const request = { id: 'task-20261003-01', title: '模拟提醒', text: '只使用隔离数据。' };
const response = (value, status = 200) => new Response(JSON.stringify(value), { status });
const accepted = { id: request.id, state: 'accepted', code: 'WECHAT_ACCEPTED', at: '2026-10-03T00:00:00.000Z' };

test('local endpoints exclude aliases, encoded hosts, user info, redirects and remote networks', () => {
  assert.equal(validateLocalWechatEndpoint(discovery.endpoint), discovery.endpoint);
  for (const endpoint of ['http://localhost:12', 'http://127.0.0.2:12', 'http://2130706433:12',
    'http://127.1:12', 'http://127.0.0.1:0', 'http://127.0.0.1:65536', 'http://127.0.0.1:012',
    'http://127.0.0.1:12/', 'http://127.0.0.1:12/path', 'http://127.0.0.1:12?x=1',
    'http://127.0.0.1:12#x', 'http://user@127.0.0.1:12', 'https://127.0.0.1:12', 'http://example.com:12'])
    assert.equal(validateLocalWechatEndpoint(endpoint), null, endpoint);
});

test('caller sends one request only to loopback and returns API acceptance without phone receipt claims', async () => {
  let calls = 0;
  const result = await requestLocalWechatNotification(client, request, { discovery, fetchImpl: async (url, options) => {
    calls++;
    assert.equal(url, discovery.endpoint + '/v1/notify');
    assert.equal(options.method, 'POST');
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers.Authorization, `Bearer ${client.token}`);
    assert.deepEqual(JSON.parse(options.body), request);
    assert.equal(options.headers.Origin, undefined);
    return response({ ...accepted, token: client.token, providerText: 'private', delivered: true });
  } });
  assert.deepEqual(result, accepted);
  assert.equal(calls, 1);
  assert.equal(result.delivered, undefined);
  assert.equal(JSON.stringify(result).includes(client.token), false);
});

test('offline discovery, bad private capability and invalid payload never enter transport', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; throw new Error('unexpected'); };
  assert.equal((await requestLocalWechatNotification(client, request,
    { readFileImpl: async () => { throw new Error('private missing path'); }, fetchImpl })).code, 'WECHAT_LOCAL_OFFLINE');
  for (const value of [{ ...client, token: 'wrong' }, { ...client, discoveryPath: 'relative.json' }])
    assert.equal((await requestLocalWechatNotification(value, request, { discovery, fetchImpl })).code, 'WECHAT_LOCAL_CONFIGURATION');
  assert.equal((await requestLocalWechatNotification(client, { ...request, extra: 'forbidden' }, { discovery, fetchImpl })).state, 'unsent');
  assert.equal((await requestLocalWechatNotification(client, request,
    { discovery: { ...discovery, endpoint: 'https://remote.example' }, fetchImpl })).state, 'unsent');
  assert.equal(calls, 0);
});

test('structured rejections and pending replays keep their state without retrying', async () => {
  const expected = [
    [{ id: request.id, state: 'unsent', code: 'WECHAT_LOCAL_BUSY' }, 429],
    [{ id: request.id, state: 'rejected', code: 'WECHAT_SESSION_EXPIRED' }, 200],
    [{ id: request.id, state: 'pending', code: 'WECHAT_LOCAL_PENDING' }, 202],
    [{ id: request.id, state: 'unknown', code: 'WECHAT_UNKNOWN' }, 200],
  ];
  for (const [value, status] of expected) {
    let calls = 0;
    const result = await requestLocalWechatNotification(client, request, { discovery, fetchImpl: async () => {
      calls++; return response(value, status);
    } });
    assert.equal(result.state, value.state);
    assert.equal(result.code, value.code);
    assert.equal(result.unsent, value.state === 'unsent' ? true : undefined);
    assert.equal(calls, 1);
  }
});

test('timeouts, malformed, oversized, redirects and unrecognized replies are unknown after POST', async () => {
  const cases = [async () => { throw new Error(`secret=${client.token}`); },
    async () => new Response('not-json', { status: 500 }),
    async () => response({ ...accepted, id: 'other-task' }),
    async () => response({ ...accepted, code: 'WECHAT_LOCAL_OFFLINE' }),
    async () => response({ ...accepted, code: client.token }),
    async () => response(accepted, 503),
    async () => new Response('x'.repeat(16385)),
    async () => new Response('{}', { headers: { 'content-length': '99999' } }),
    async () => new Promise(() => {}),
  ];
  for (const fetchImpl of cases) {
    const result = await requestLocalWechatNotification(client, request, { discovery, fetchImpl, timeoutMs: 5 });
    assert.deepEqual(result, { id: request.id, state: 'unknown', code: 'WECHAT_UNKNOWN' });
    assert.equal(JSON.stringify(result).includes(client.token), false);
  }
});

test('refused connection is unsent; cancellation before fetch differs from cancellation in flight', async () => {
  const offline = await requestLocalWechatNotification(client, request, { discovery,
    fetchImpl: async () => { throw Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } }); } });
  assert.equal(offline.state, 'unsent');
  const early = new AbortController(); early.abort();
  assert.equal((await requestLocalWechatNotification(client, request, { discovery, signal: early.signal })).code, 'WECHAT_LOCAL_CANCELLED');
  const late = new AbortController();
  const pending = requestLocalWechatNotification(client, request, { discovery, signal: late.signal,
    fetchImpl: async () => { queueMicrotask(() => late.abort()); return new Promise(() => {}); } });
  assert.equal((await pending).code, 'WECHAT_UNKNOWN');
});

test('cancellation during discovery read never starts transport', async () => {
  const cancellation = new AbortController();
  let finishRead, markReading, calls = 0;
  const reading = new Promise((resolve) => { markReading = resolve; });
  const pending = requestLocalWechatNotification(client, request, {
    signal: cancellation.signal,
    readFileImpl: () => {
      markReading();
      return new Promise((resolve) => { finishRead = resolve; });
    },
    fetchImpl: async () => { calls++; return response(accepted); },
  });
  await reading;
  cancellation.abort();
  finishRead(Buffer.from(JSON.stringify(discovery)));
  assert.deepEqual(await pending, { id: request.id, state: 'unsent',
    code: 'WECHAT_LOCAL_CANCELLED', unsent: true });
  assert.equal(calls, 0);
});

test('synchronous cancellation while registering its listener is proved unsent', async () => {
  const cancellation = new AbortController();
  const addEventListener = cancellation.signal.addEventListener.bind(cancellation.signal);
  cancellation.signal.addEventListener = (...args) => {
    addEventListener(...args);
    cancellation.abort();
  };
  let calls = 0;
  const result = await requestLocalWechatNotification(client, request, {
    discovery, signal: cancellation.signal,
    fetchImpl: async () => { calls++; return response(accepted); },
  });
  assert.deepEqual(result, { id: request.id, state: 'unsent',
    code: 'WECHAT_LOCAL_CANCELLED', unsent: true });
  assert.equal(calls, 0);
});

test('status reads are GET and return only bounded public metadata', async () => {
  const value = { state: 'status', code: 'WECHAT_LOCAL_STATUS', running: true, queued: 1, sending: true,
    client: { id: 'mock-agent', label: '模拟 agent', token: client.token }, receipts: [accepted],
    capacity: { clients: 8, receipts: 100 }, providerSession: client.token };
  const result = await requestLocalWechatNotification(client, undefined, { discovery, mode: 'status', fetchImpl: async (url, options) => {
    assert.equal(url, discovery.endpoint + '/v1/status');
    assert.equal(options.method, 'GET');
    assert.equal(options.body, undefined);
    return response(value);
  } });
  assert.equal(result.state, 'status');
  assert.deepEqual(result.client, { id: 'mock-agent', label: '模拟 agent' });
  assert.equal(JSON.stringify(result).includes(client.token), false);
  assert.equal(sanitizeLocalWechatResult({ ...value, running: 'yes' }, { mode: 'status' }), null);
});

test('UTF8 payload and file reads obey byte limits rather than JS character counts', async () => {
  assert.equal(validLocalWechatRequest({ ...request, text: '字'.repeat(3000) }), false);
  assert.equal(validLocalWechatRequest({ ...request, id: 'same id with spaces' }), false);
  const directory = await mkdtemp(join(tmpdir(), 'codex-local-wechat-test-'));
  try {
    const path = join(directory, 'public.json');
    await writeFile(path, '12345');
    assert.equal((await readLimitedLocalFile(path, 5)).toString(), '12345');
    await assert.rejects(readLimitedLocalFile(path, 4), /LOCAL_FILE_TOO_LARGE/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
