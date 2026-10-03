import assert from 'node:assert/strict';
import test from 'node:test';
import { createLocalClientBridge, takeLocalClientBridge, readLocalClientBridge, returnLocalClientBridge } from './wechat-local-bridge.mjs';

const request = { id: 'isolated-bridge-01', title: '模拟', text: '仅在本机使用的模拟通知。' };
test('one-use authenticated bridge keeps input in RAM, removes inherited capability and sanitizes result', async (t) => {
  let result;
  const server = await createLocalClientBridge({ request, mode: 'notify', onResult: (value) => { result = value; } });
  t.after(() => server.close());
  const environment = { ...server.env };
  const bridge = takeLocalClientBridge(environment);
  assert.deepEqual(environment, {});
  assert.match(bridge.endpoint, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.equal((await fetch(`${bridge.endpoint}/input`)).status, 403);
  assert.equal((await fetch(`${bridge.endpoint}/input`, { headers: { Authorization: `Bearer ${bridge.token}`, Origin: 'http://untrusted.test' } })).status, 403);
  assert.deepEqual(await readLocalClientBridge(bridge), { version: 1, mode: 'notify', request });
  await assert.rejects(readLocalClientBridge(bridge));
  await returnLocalClientBridge(bridge, { id: request.id, state: 'accepted', code: 'WECHAT_ACCEPTED', token: 'private-mock-value' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(result, { id: request.id, state: 'accepted', code: 'WECHAT_ACCEPTED' });
  await assert.rejects(returnLocalClientBridge(bridge, result));
});

test('malformed bridge capabilities and unsafe endpoints fail before a fetch', () => {
  for (const endpoint of ['http://localhost:8080', 'https://127.0.0.1:443', 'http://10.0.0.1:1234', 'http://127.0.0.1:8/input']) {
    assert.throws(() => takeLocalClientBridge({ CODEX_WECHAT_HELPER_BRIDGE: endpoint, CODEX_WECHAT_HELPER_KEY: 'a'.repeat(43) }));
  }
});
