import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { WechatGateway } from './gateway.mjs';
import { createProbeStorage } from './storage.mjs';

const payload = (id = 'event-1', text = 'Synthetic notification only.') => ({ id, title: 'Test', text });
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'wechat-gateway-test-'));
  const data = { saved: null, writes: [] };
  const storage = options.storage ?? {
    read: async () => structuredClone(data.saved),
    write: async (value) => { data.saved = structuredClone(value); data.writes.push(structuredClone(value)); },
  };
  const sent = [];
  const gateway = new WechatGateway({ storage, cooldownMs: 0,
    discoveryPath: join(directory, 'gateway.json'),
    sendText: async (text) => { sent.push(text); return { confirmation: 'accepted' }; }, ...options });
  await gateway.start();
  t.after(async () => { await gateway.stop(); await rm(directory, { recursive: true, force: true }); });
  const capability = await gateway.addClient('Agent A');
  async function http(body = payload(), extra = {}) {
    const response = await fetch(`${gateway.status().endpoint}/v1/notify`, {
      method: 'POST', headers: { authorization: `Bearer ${capability.token}`, 'content-type': 'application/json', ...extra.headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  }
  return { gateway, directory, data, storage, capability, sent, http };
}
async function waitUntil(predicate) {
  for (let count = 0; count < 100; count++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('Synthetic gateway condition did not settle.');
}

test('binds only IPv4 loopback; capability export is private and discovery is public', async (t) => {
  const { gateway, directory, capability, data } = await fixture(t);
  assert.equal(gateway.server.address().address, '127.0.0.1');
  assert.equal(capability.kind, 'wechat-local-client');
  assert.equal(Buffer.from(capability.token, 'base64url').length, 32);
  const discovery = JSON.parse(await readFile(join(directory, 'gateway.json'), 'utf8'));
  assert.deepEqual(Object.keys(discovery).sort(), ['endpoint', 'version']);
  assert.equal(discovery.endpoint, gateway.status().endpoint);
  assert.equal(JSON.stringify(data.saved).includes(capability.token), false);
  assert.equal(JSON.stringify(gateway.status()).includes(capability.token), false);
  await gateway.stop();
  await assert.rejects(readFile(join(directory, 'gateway.json')), { code: 'ENOENT' });
});

test('prefixes registered source, persists pending first, and never stores content', async (t) => {
  let fixtureData;
  const f = await fixture(t, { sendText: async (text) => {
    assert.equal(fixtureData.saved.receipts[0].state, 'pending');
    assert.equal(text, '[Agent A] Test\nSynthetic notification only.');
    return { confirmation: 'accepted' };
  } });
  fixtureData = f.data;
  const response = await f.http();
  assert.equal(response.body.state, 'accepted');
  assert.equal(response.body.code, 'WECHAT_ACCEPTED');
  assert.equal(JSON.stringify(f.data.saved).includes('Synthetic notification only.'), false);
  assert.equal(JSON.stringify(response.body).includes(f.capability.token), false);
});

test('same payload and ID cannot resend; changed payload conflicts', async (t) => {
  const { http, sent } = await fixture(t);
  assert.equal((await http()).body.state, 'accepted');
  assert.equal((await http()).body.state, 'accepted');
  const changed = await http(payload('event-1', 'Changed body.'));
  assert.equal(changed.status, 409);
  assert.equal(changed.body.code, 'WECHAT_LOCAL_CONFLICT');
  assert.equal(sent.length, 1);
});

test('pending duplicate is visible and shares no second transport', async (t) => {
  const gate = deferred(); let sends = 0;
  const { http, gateway } = await fixture(t, { sendText: async () => { sends++; await gate.promise; return { confirmation: 'accepted' }; } });
  const first = http();
  await waitUntil(() => gateway.status().sending);
  const duplicate = await http();
  assert.equal(duplicate.status, 202);
  assert.equal(duplicate.body.state, 'pending');
  assert.equal(duplicate.body.code, 'WECHAT_LOCAL_PENDING');
  gate.resolve(); assert.equal((await first).body.state, 'accepted'); assert.equal(sends, 1);
});

test('idempotency scope separates two registered clients', async (t) => {
  const { gateway, http, sent } = await fixture(t);
  const second = await gateway.addClient('Agent B');
  await http();
  await http(payload(), { headers: { authorization: `Bearer ${second.token}` } });
  assert.equal(sent.length, 2);
  assert.equal(sent[1].startsWith('[Agent B]'), true);
});

test('accepted, unknown and rejected receipts survive restart without retries', async (t) => {
  let sends = 0;
  const { gateway, http } = await fixture(t, { sendText: async (text) => {
    sends++;
    if (text.endsWith('unknown')) throw Object.assign(new Error('Private error body'), { code: 'WECHAT_TIMEOUT' });
    if (text.endsWith('rejected')) throw Object.assign(new Error('Private error body'), { code: 'WECHAT_REJECTED' });
    return { confirmation: 'accepted' };
  } });
  for (const state of ['accepted', 'unknown', 'rejected']) assert.equal((await http(payload(state, state))).body.state, state);
  await gateway.stop(); await gateway.start();
  for (const state of ['accepted', 'unknown', 'rejected']) assert.equal((await http(payload(state, state))).body.state, state);
  assert.equal(sends, 3);
});

test('recovers a crash-time pending receipt as unknown before listening', async (t) => {
  const { gateway, http, data } = await fixture(t);
  await http(); await gateway.stop();
  data.saved.receipts[0].state = 'pending'; data.saved.receipts[0].code = 'WECHAT_LOCAL_PENDING';
  await gateway.start();
  assert.equal(data.saved.receipts[0].state, 'unknown');
  assert.equal((await http()).body.state, 'unknown');
});

test('strict request shape refuses recipient, context, provider URL and invalid text', async (t) => {
  const { http, sent } = await fixture(t);
  for (const extra of ['recipient', 'contextToken', 'token', 'baseUrl']) {
    assert.equal((await http({ ...payload(), [extra]: 'forbidden' })).status, 400);
  }
  for (const value of [{ ...payload(), id: 123 }, { ...payload(), title: 'x'.repeat(101) },
    { ...payload(), text: '' }, { ...payload(), text: 'x'.repeat(4001) }, { ...payload(), title: 'bad\nname' },
    { ...payload(), text: 'bad\u0000body' }]) assert.equal((await http(value)).status, 400);
  assert.equal(sent.length, 0);
});

test('bounds bytes separately from character counts and JSON size', async (t) => {
  const { http, sent } = await fixture(t);
  assert.equal((await http(payload('event-1', '中'.repeat(3000)))).status, 413);
  assert.equal((await http(JSON.stringify(payload('event-1', 'x'.repeat(20000))))).status, 413);
  assert.equal((await http('{malformed')).status, 400);
  assert.equal(sent.length, 0);
});

test('rejects browser Origin, unsafe Host, unauthenticated status and unsupported paths', async (t) => {
  const { gateway, http, capability, sent } = await fixture(t);
  assert.equal((await http(payload(), { headers: { Origin: 'http://localhost' } })).body.code, 'WECHAT_LOCAL_ORIGIN');
  const unsafeHost = await new Promise((resolve, reject) => {
    const outgoing = request(`${gateway.status().endpoint}/v1/notify`, { method: 'POST',
      headers: { Host: 'attacker.example', authorization: `Bearer ${capability.token}`, 'content-type': 'application/json' } }, (response) => {
      let text = '';
      response.on('data', (chunk) => { text += chunk; });
      response.on('end', () => { try { resolve(JSON.parse(text)); } catch (error) { reject(error); } });
    });
    outgoing.on('error', reject);
    outgoing.end(JSON.stringify(payload()));
  });
  assert.equal(unsafeHost.code, 'WECHAT_LOCAL_HOST');
  assert.equal((await http(payload(), { headers: { authorization: 'Bearer invalid' } })).status, 401);
  const status = await fetch(`${gateway.status().endpoint}/v1/status`);
  assert.equal(status.status, 401);
  const noRoute = await fetch(`${gateway.status().endpoint}/v1/notify?target=alternate`, { method: 'POST',
    headers: { authorization: `Bearer ${capability.token}` } });
  assert.equal(noRoute.status, 404); assert.equal(sent.length, 0);
});

test('no CORS headers and client status contains only own receipts', async (t) => {
  const { gateway, http, capability } = await fixture(t);
  const other = await gateway.addClient('Agent B');
  await http(payload('a'));
  await http(payload('b'), { headers: { authorization: `Bearer ${other.token}` } });
  const response = await fetch(`${gateway.status().endpoint}/v1/status`, {
    headers: { authorization: `Bearer ${capability.token}` } });
  assert.equal(response.headers.has('access-control-allow-origin'), false);
  const body = await response.json();
  assert.equal(body.state, 'status'); assert.equal(body.code, 'WECHAT_LOCAL_STATUS');
  assert.deepEqual(body.receipts.map((receipt) => receipt.id), ['a']);
  assert.equal(JSON.stringify(body).includes('Synthetic notification only.'), false);
  assert.equal(JSON.stringify(body).includes(other.clientId), false);
});

test('revoked capabilities remain invalid after restart', async (t) => {
  const { gateway, http, sent, capability } = await fixture(t);
  await gateway.revokeClient(capability.clientId);
  assert.equal((await http()).status, 401);
  await gateway.stop(); await gateway.start();
  assert.equal((await http()).status, 401); assert.equal(sent.length, 0);
});

test('ledger and client hard capacity refuse new requests without evicting prior IDs', async (t) => {
  const { gateway, http, sent } = await fixture(t, { maxReceipts: 1, maxClients: 1 });
  await assert.rejects(gateway.addClient('Agent B'), { code: 'WECHAT_LOCAL_CAPACITY' });
  await http(payload('retained'));
  assert.equal((await http(payload('new'))).body.code, 'WECHAT_LOCAL_CAPACITY');
  assert.equal((await http(payload('retained'))).body.state, 'accepted');
  assert.equal(gateway.status().receipts.length, 1); assert.equal(sent.length, 1);
});

test('busy and cooldown are rejected before ledger admission and can retry same ID later', async (t) => {
  let now = Date.now(); const gate = deferred(); let sends = 0;
  const { gateway, http } = await fixture(t, { now: () => now, cooldownMs: 15000,
    sendText: async () => { sends++; await gate.promise; return { confirmation: 'accepted' }; } });
  const first = http(payload('first'));
  await waitUntil(() => gateway.status().sending);
  const blocked = await http(payload('later'));
  assert.equal(blocked.body.state, 'unsent'); assert.equal(blocked.body.code, 'WECHAT_LOCAL_COOLDOWN');
  assert.equal(gateway.status().receipts.length, 1);
  gate.resolve(); await first; now += 15001;
  assert.equal((await http(payload('later'))).body.state, 'accepted'); assert.equal(sends, 2);
});

test('bounded queue serializes sends and reports full as unsent', async (t) => {
  const gate = deferred(); let active = 0, peak = 0, sends = 0;
  const { gateway, http } = await fixture(t, { maxQueue: 1, sendText: async () => {
    active++; peak = Math.max(peak, active); sends++; await gate.promise; active--; return { confirmation: 'accepted' };
  } });
  const first = http(payload('one')); await waitUntil(() => gateway.status().sending);
  const second = http(payload('two')); await waitUntil(() => gateway.status().queued === 1);
  const third = await http(payload('three'));
  assert.equal(third.body.code, 'WECHAT_LOCAL_BUSY'); assert.equal(third.body.unsent, true);
  gate.resolve(); assert.equal((await first).body.state, 'accepted'); assert.equal((await second).body.state, 'accepted');
  assert.equal(peak, 1); assert.equal(sends, 2);
});

test('proved-unsent adapter refusal allows explicit same-ID resubmission only', async (t) => {
  let attempts = 0;
  const { http } = await fixture(t, { sendText: async () => {
    attempts++;
    if (attempts === 1) throw Object.assign(new Error('Not bound'), { code: 'PROBE_STATE', unsent: true });
    return { confirmation: 'accepted' };
  } });
  const first = await http(); assert.equal(first.body.state, 'unsent'); assert.equal(first.body.unsent, true);
  assert.equal((await http(payload('event-1', 'Changed body'))).status, 409);
  assert.equal((await http()).body.state, 'accepted');
  assert.equal((await http()).body.state, 'accepted'); assert.equal(attempts, 2);
});

test('storage failure before transport prevents sends', async (t) => {
  let saved = null, fail = false, sends = 0;
  const storage = { read: async () => saved, write: async (value) => {
    if (fail) throw new Error('Synthetic storage unavailable'); saved = structuredClone(value);
  } };
  const { http } = await fixture(t, { storage, sendText: async () => { sends++; return { confirmation: 'accepted' }; } });
  fail = true;
  const response = await http(); assert.equal(response.body.state, 'unsent');
  assert.equal(response.body.code, 'WECHAT_LOCAL_STORAGE'); assert.equal(sends, 0);
});

test('storage failure after transport is unknown and never resends', async (t) => {
  let saved = null, fail = false, sends = 0;
  const storage = { read: async () => saved, write: async (value) => {
    if (fail) throw new Error('Synthetic storage unavailable'); saved = structuredClone(value);
  } };
  const { gateway, http } = await fixture(t, { storage, sendText: async () => {
    sends++; fail = true; return { confirmation: 'accepted' };
  } });
  assert.equal((await http()).body.state, 'unknown');
  assert.equal((await http()).body.code, 'WECHAT_LOCAL_STORAGE');
  fail = false; await gateway.stop(); await gateway.start();
  assert.equal((await http()).body.state, 'unknown'); assert.equal(sends, 1);
});

test('stop resolves in-flight uncertainty, marks queued work unsent, and removes discovery', async (t) => {
  const gate = deferred(); let sends = 0;
  const { gateway, http, directory } = await fixture(t, { sendText: async () => { sends++; await gate.promise; return { confirmation: 'accepted' }; } });
  const first = http(payload('active')); await waitUntil(() => gateway.status().sending);
  const second = http(payload('queued')); await waitUntil(() => gateway.status().queued === 1);
  await gateway.stop();
  assert.equal((await first).body.state, 'unknown'); assert.equal((await second).body.state, 'unsent');
  assert.equal(sends, 1); await assert.rejects(readFile(join(directory, 'gateway.json')), { code: 'ENOENT' });
  gate.resolve();
});

test('deadline returns unknown without overlapping a non-cooperative transport', async (t) => {
  const gate = deferred(); let sends = 0;
  const { gateway, http } = await fixture(t, { sendTimeoutMs: 15,
    sendText: async () => { sends++; await gate.promise; return { confirmation: 'accepted' }; } });
  assert.equal((await http(payload('timed'))).body.state, 'unknown');
  const second = http(payload('waiting')); await waitUntil(() => gateway.status().queued === 1);
  await new Promise((resolve) => setTimeout(resolve, 25)); assert.equal(sends, 1);
  gate.resolve(); assert.equal((await second).body.state, 'accepted');
});

test('explicit binding reset invalidates old capabilities and clears in-memory public registry', async (t) => {
  const { gateway, http, data } = await fixture(t);
  await http(); await gateway.reset();
  assert.equal(gateway.status().clients.length, 0); assert.equal(data.saved.receipts.length, 0);
  await gateway.start(); assert.equal((await http()).status, 401);
});

test('start reloads null storage without retaining a removed registry', async (t) => {
  const { gateway, http, data } = await fixture(t);
  await gateway.stop(); data.saved = null; await gateway.start();
  assert.equal(gateway.status().clients.length, 0); assert.equal((await http()).status, 401);
});

test('corrupt or oversized durable state refuses to open a listener', async (t) => {
  const { gateway, data } = await fixture(t);
  await gateway.stop(); data.saved.receipts = [{ clientId: 'missing', id: 'x' }];
  await assert.rejects(gateway.start(), { code: 'WECHAT_LOCAL_STORAGE' });
  assert.equal(gateway.status().running, false);
});

test('duplicate authentication headers are rejected without a send', async (t) => {
  const { gateway, capability, sent } = await fixture(t);
  const url = new URL(`${gateway.status().endpoint}/v1/status`);
  const result = await new Promise((resolve, reject) => {
    const req = request(url, { headers: { Authorization: [`Bearer ${capability.token}`, 'Bearer unrelated'] } }, (response) => {
      response.resume(); response.on('end', () => resolve(response.statusCode));
    }); req.on('error', reject); req.end();
  });
  assert.equal(result, 401); assert.equal(sent.length, 0);
});

test('encrypted storage integration uses a separate isolated mock profile', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'wechat-gateway-encrypted-test-'));
  const crypto = { isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(`MOCK ENCRYPTED\n${Buffer.from(value).toString('base64')}`),
    decryptString: (value) => Buffer.from(value.toString().split('\n')[1], 'base64').toString() };
  const storage = createProbeStorage(directory, crypto);
  const f = await fixture(t, { storage });
  t.after(() => rm(directory, { recursive: true, force: true }));
  await f.http();
  const disk = await readFile(join(directory, 'session.bin'), 'utf8');
  assert.equal(disk.includes(f.capability.token), false);
  assert.equal(disk.includes('Synthetic notification only.'), false);
  await f.gateway.stop(); await f.gateway.start(); assert.equal((await f.http()).body.state, 'accepted');
});
