import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WechatProbe, SYNTHETIC_TEXT } from './controller.mjs';

const session = { token: 'synthetic-secret-not-real', userId: 'synthetic-user', baseUrl: 'https://ilinkai.weixin.qq.com' };
function fixture({ saved = null, sendError = null } = {}) {
  let time = Date.parse('2026-10-02T08:00:00Z');
  const writes = [], statuses = [], sends = [], timers = new Map();
  let nextTimer = 0;
  const client = {
    async notify() {},
    async getUpdates(_session, { signal }) {
      await new Promise(resolve => {
        if (signal.aborted) return resolve();
        signal.addEventListener('abort', resolve, { once: true });
      });
      return { ret: 0, msgs: [] };
    },
    async sendText(connection, input) {
      sends.push({ connection, ...input });
      if (sendError) throw sendError;
      return { confirmation: 'accepted' };
    },
    async requestQr() { return { qrcode: 'synthetic-qr', qrcode_img_content: 'https://ilinkai.weixin.qq.com/mock' }; },
    async pollQr() { return { status: 'confirmed', bot_token: session.token, ilink_user_id: session.userId, baseurl: session.baseUrl }; },
  };
  const storage = {
    async read() { return saved; },
    async write(value) { writes.push(structuredClone(value)); },
    async remove() { writes.push('removed'); },
    async writeStatus() {},
  };
  const probe = new WechatProbe({ client, storage, renderQr: () => 'data:image/svg+xml;base64,bW9jaw==',
    publish: value => statuses.push(structuredClone(value)), now: () => time,
    setTimer: callback => { timers.set(++nextTimer, callback); return nextTimer; },
    clearTimer: id => timers.delete(id),
  });
  function bind() { probe.session = { ...session }; probe.phase = 'bound'; probe.contextToken = 'original-context'; probe.contextAt = new Date(time).toISOString(); }
  return { probe, client, writes, statuses, sends, timers, bind,
    advance: milliseconds => { time += milliseconds; }, fire: async () => { const entry = [...timers.entries()][0]; timers.delete(entry[0]); await entry[1](); } };
}

test('probe public status excludes session credentials, context, cursor and inbound text', () => {
  const f = fixture(); f.bind(); f.probe.cursor = 'private-cursor';
  const publicState = JSON.stringify(f.probe.status());
  for (const secret of [session.token, session.userId, 'original-context', 'private-cursor']) assert.ok(!publicState.includes(secret));
});

test('probe persists pending before a fixed synthetic send and never claims receipt', async () => {
  const f = fixture(); f.bind();
  await f.probe.send();
  assert.equal(f.writes[0].tests[0].confirmation, 'pending');
  assert.equal(f.sends.length, 1);
  assert.ok(f.sends[0].text.startsWith(SYNTHETIC_TEXT));
  assert.ok(f.sends[0].text.includes(f.probe.tests[0].id.slice(0, 8)));
  assert.equal(f.sends[0].contextToken, 'original-context');
  assert.equal(f.probe.status().tests[0].confirmation, 'accepted');
  await f.probe.confirm(f.probe.tests[0].id);
  assert.equal(f.probe.status().tests[0].confirmation, 'received');
});

test('unknown send remains one attempt and private error text never escapes', async () => {
  const error = Object.assign(new Error('secret from request body'), { code: 'WECHAT_UNKNOWN', httpStatus: 502,
    responseRet: 0, responseErrcode: -7,
    errmsg: 'synthetic-response-secret', rawResponse: { token: 'synthetic-private-token' }, body: 'synthetic-private-body' });
  const f = fixture({ sendError: error }); f.bind();
  await f.probe.send();
  assert.equal(f.sends.length, 1);
  assert.equal(f.probe.tests[0].confirmation, 'unknown');
  assert.equal(f.probe.status().tests[0].httpStatus, 502);
  assert.equal(f.writes.at(-1).tests[0].httpStatus, 502);
  for (const record of [f.probe.status().tests[0], f.writes.at(-1).tests[0]]) {
    assert.equal(record.responseRet, 0);
    assert.equal(record.responseErrcode, -7);
  }
  assert.ok(!f.probe.message.includes(error.message));
  for (const value of [error.message, error.errmsg, error.rawResponse.token, error.body]) {
    assert.ok(!JSON.stringify(f.probe.status()).includes(value));
    assert.ok(!JSON.stringify(f.writes.at(-1).tests).includes(value));
  }
  await assert.rejects(f.probe.send(), /15 秒/);
  assert.equal(f.sends.length, 1);
});

test('explicit rejection preserves only bounded numeric diagnostics through persistence and public status', async () => {
  const error = Object.assign(new Error('synthetic-private-error'), { code: 'WECHAT_REJECTED',
    businessCode: -7, httpStatus: 403, responseRet: -7, responseErrcode: 0,
    errmsg: 'synthetic-private-response', token: 'synthetic-private-token', body: 'synthetic-private-body' });
  const f = fixture({ sendError: error }); f.bind();
  await f.probe.send();
  const record = f.probe.status().tests[0];
  assert.equal(record.confirmation, 'rejected');
  assert.equal(record.code, 'WECHAT_REJECTED');
  assert.equal(record.businessCode, -7);
  assert.equal(record.httpStatus, 403);
  assert.equal(record.responseRet, -7);
  assert.equal(record.responseErrcode, 0);
  assert.deepEqual(f.writes.at(-1).tests[0], record);
  for (const value of [error.message, error.errmsg, error.token, error.body]) assert.ok(!JSON.stringify(record).includes(value));
  assert.equal(f.sends.length, 1);
  await assert.rejects(f.probe.confirm(record.id), /不能确认收到/);
});

test('diagnostic strings, fractions, non-finite values and out-of-range integers never persist', async () => {
  const invalid = [
    ['synthetic-private-business', 'synthetic-private-http'], ['-7', '403'], [null, null],
    [true, false], [1.5, 403.5], [NaN, NaN], [Infinity, Infinity],
    [-2147483649, 99], [2147483648, 600], [Number.MAX_SAFE_INTEGER, -403],
  ];
  for (const [businessCode, httpStatus] of invalid) {
    const f = fixture({ sendError: Object.assign(new Error('synthetic-private-error'), {
      code: 'WECHAT_REJECTED', businessCode, httpStatus, responseRet: businessCode, responseErrcode: businessCode,
    }) }); f.bind();
    await f.probe.send();
    for (const record of [f.probe.status().tests[0], f.writes.at(-1).tests[0]]) {
      assert.equal(Object.hasOwn(record, 'businessCode'), false);
      assert.equal(Object.hasOwn(record, 'httpStatus'), false);
      assert.equal(Object.hasOwn(record, 'responseRet'), false);
      assert.equal(Object.hasOwn(record, 'responseErrcode'), false);
      assert.ok(!JSON.stringify(record).includes('synthetic-private'));
    }
  }
});

test('ambiguous response diagnostics are filtered independently and never change unknown into rejection', async () => {
  for (const diagnostics of [
    { responseRet: 0, responseErrcode: 'synthetic-private-errcode' },
    { responseRet: 'synthetic-private-ret', responseErrcode: -7 },
  ]) {
    const f = fixture({ sendError: Object.assign(new Error('synthetic-private-error'), {
      code: 'WECHAT_UNKNOWN', ...diagnostics,
    }) }); f.bind();
    await f.probe.send();
    for (const record of [f.probe.status().tests[0], f.writes.at(-1).tests[0]]) {
      assert.equal(record.confirmation, 'unknown');
      assert.equal(record.code, 'WECHAT_UNKNOWN');
      assert.equal(Object.hasOwn(record, 'businessCode'), false);
      for (const key of ['responseRet', 'responseErrcode']) {
        if (typeof diagnostics[key] === 'number') assert.equal(record[key], diagnostics[key]);
        else assert.equal(Object.hasOwn(record, key), false);
      }
      assert.ok(!JSON.stringify(record).includes('synthetic-private'));
    }
    assert.equal(f.sends.length, 1);
  }
});

test('recovery preserves numeric diagnostics and legacy records, drops unsafe fields and never resends', async () => {
  const legacy = { id: 'legacy-test', label: '即时测试', at: '2026-10-02T08:00:00Z', confirmation: 'received',
    code: 'WECHAT_UNKNOWN', contextAgeMinutes: 5 };
  const valid = { ...legacy, id: 'rejected-test', confirmation: 'rejected', code: 'WECHAT_REJECTED',
    businessCode: -14, httpStatus: 429, responseRet: -14, responseErrcode: 0 };
  const unsafe = { ...legacy, id: 'interrupted-test', confirmation: 'pending', code: 'synthetic-private-code',
    businessCode: 'synthetic-private-business', httpStatus: 600, responseRet: 'synthetic-private-ret', responseErrcode: 2147483648,
    rawResponse: 'synthetic-private-response', errmsg: 'synthetic-private-message' };
  const f = fixture({ saved: { version: 1, session, tests: [valid, legacy, unsafe] } });
  try {
    await f.probe.initialize();
    assert.deepEqual(f.probe.status().tests[0], valid);
    assert.deepEqual(f.probe.status().tests[1], legacy);
    assert.deepEqual(f.probe.status().tests[2], { id: unsafe.id, label: legacy.label, at: legacy.at,
      confirmation: 'unknown', contextAgeMinutes: 5 });
    assert.equal(f.sends.length, 0);
    assert.equal(f.timers.size, 0);
    assert.ok(!JSON.stringify(f.probe.tests).includes('synthetic-private'));
    // Public status remains an allowlist even if a caller supplies unsafe extras.
    f.probe.tests[0].rawResponse = 'synthetic-private-response';
    f.probe.tests[0].businessCode = 2147483648;
    f.probe.tests[0].responseRet = 'synthetic-private-ret';
    f.probe.tests[0].responseErrcode = -2147483649;
    assert.equal(Object.hasOwn(f.probe.status().tests[0], 'businessCode'), false);
    assert.equal(Object.hasOwn(f.probe.status().tests[0], 'responseRet'), false);
    assert.equal(Object.hasOwn(f.probe.status().tests[0], 'responseErrcode'), false);
    assert.ok(!JSON.stringify(f.probe.status()).includes('synthetic-private'));
    await f.probe.persist();
    assert.equal(Object.hasOwn(f.writes.at(-1).tests[0], 'businessCode'), false);
    assert.equal(Object.hasOwn(f.writes.at(-1).tests[0], 'responseRet'), false);
    assert.equal(Object.hasOwn(f.writes.at(-1).tests[0], 'responseErrcode'), false);
    assert.ok(!JSON.stringify(f.writes.at(-1).tests).includes('synthetic-private'));
  } finally { await f.probe.stop(); }
});

test('omitting context is explicit and does not attach current conversation token', async () => {
  const f = fixture(); f.bind();
  await f.probe.send({ omitContext: true });
  assert.equal(f.sends[0].contextToken, undefined);
  assert.equal(f.probe.tests[0].contextAgeMinutes, undefined);
});

test('25 hour delay uses original context even if a new conversation arrives', async () => {
  const f = fixture(); f.bind();
  await f.probe.schedule(1500);
  f.advance(1500 * 60000);
  f.probe.contextToken = 'newer-context'; f.probe.contextAt = new Date().toISOString();
  await f.fire();
  assert.equal(f.sends.length, 1);
  assert.equal(f.sends[0].contextToken, 'original-context');
  assert.equal(f.probe.tests[0].contextAgeMinutes, 1500);
  assert.equal(f.probe.scheduled, null);
});

test('cancelling or exiting removes scheduled sends and reopening cannot resume them', async () => {
  const f = fixture(); f.bind();
  await f.probe.schedule(5); await f.probe.cancelSchedule();
  assert.equal(f.timers.size, 0); assert.equal(f.sends.length, 0);
  await f.probe.schedule(1500); await f.probe.stop();
  assert.equal(f.timers.size, 0); assert.equal(f.sends.length, 0);
  assert.equal(f.probe.status().scheduled, null);
  assert.ok(f.writes.every(value => !value?.scheduled));
});

test('restart recovery converts interrupted pending attempts to unknown without resend', async () => {
  const f = fixture({ saved: { version: 1, session, contextToken: 'saved-context', contextAt: '2026-10-02T08:00:00Z',
    cursor: 'saved-cursor', tests: [{ id: 'test-before-crash', label: '即时测试', at: '2026-10-02T08:00:00Z', confirmation: 'pending' }] } });
  await f.probe.initialize();
  assert.equal(f.probe.tests[0].confirmation, 'unknown');
  assert.equal(f.sends.length, 0);
  assert.equal(f.probe.scheduled, null);
  await f.probe.stop();
});

test('a session expiry rejects a send and cancels any outstanding delayed experiment', async () => {
  const f = fixture({ sendError: Object.assign(new Error('raw secret'), { code: 'WECHAT_SESSION_EXPIRED' }) }); f.bind();
  await f.probe.schedule(1500); await f.probe.send();
  assert.equal(f.probe.phase, 'expired'); assert.equal(f.probe.tests[0].confirmation, 'rejected');
  assert.equal(f.timers.size, 0); assert.equal(f.probe.status().bound, false);
});

test('forgetting removes only the independent stored test connection and clears pending jobs', async () => {
  const f = fixture(); f.bind(); await f.probe.schedule(5);
  await f.probe.forget();
  assert.equal(f.writes.at(-1), 'removed'); assert.equal(f.probe.session, null);
  assert.equal(f.probe.phase, 'idle'); assert.equal(f.timers.size, 0);
});
