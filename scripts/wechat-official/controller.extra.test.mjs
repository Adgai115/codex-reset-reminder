import test from 'node:test';
import assert from 'node:assert/strict';
import { WechatProbe } from './controller.mjs';

const syntheticSession = {
  token: 'synthetic-extra-secret', userId: 'synthetic-extra-user',
  baseUrl: 'https://ilinkai.weixin.qq.com',
};

async function waitFor(predicate) {
  const deadline = Date.now() + 1000;
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.ok(predicate(), 'Mock operation did not reach its expected state');
}

async function waitForAbort(signal) {
  await new Promise((resolve) => {
    if (signal.aborted) return resolve();
    signal.addEventListener('abort', resolve, { once: true });
  });
  return { ret: 0, msgs: [] };
}

test('optional lifecycle request failure does not prevent receiving a validation message', async () => {
  let updateCalls = 0;
  const storage = { read: async () => ({ version: 1, session: syntheticSession }),
    write: async () => {}, writeStatus: async () => {} };
  const client = {
    async notify() { throw Object.assign(new Error('synthetic-response-secret'), { code: 'WECHAT_NETWORK' }); },
    async getUpdates(_session, { signal }) {
      updateCalls += 1;
      if (updateCalls === 1) return { ret: 0, msgs: [{
        from_user_id: syntheticSession.userId, message_type: 1,
        context_token: 'synthetic-extra-context',
      }] };
      return waitForAbort(signal);
    },
  };
  const probe = new WechatProbe({ client, storage, renderQr: () => '' });
  try {
    await probe.initialize();
    await waitFor(() => probe.status().hasContext);
    assert.equal(probe.listening, true);
    assert.ok(!JSON.stringify(probe.status()).includes('synthetic-response-secret'));
  } finally { await probe.stop(); }
});

test('clearing a connection is blocked while login waits for encrypted storage', async () => {
  let releaseWrite;
  let saveStarted = false;
  let stored = null;
  let storageWrites = Promise.resolve();
  const seenConnections = [];
  const storage = {
    read: async () => null,
    write(value) {
      const operation = storageWrites.then(async () => {
        saveStarted = true;
        await new Promise((resolve) => { releaseWrite = resolve; });
        stored = value;
      });
      storageWrites = operation;
      return operation;
    },
    writeStatus: async () => {},
    remove() {
      const operation = storageWrites.then(() => { stored = null; });
      storageWrites = operation;
      return operation;
    },
  };
  const client = {
    requestQr: async () => ({ qrcode: 'synthetic-extra-qr', qrcode_img_content: syntheticSession.baseUrl }),
    pollQr: async () => ({ status: 'confirmed', bot_token: syntheticSession.token,
      ilink_user_id: syntheticSession.userId, baseurl: syntheticSession.baseUrl }),
    async notify(connection) { seenConnections.push(connection); },
    async getUpdates(connection, { signal }) {
      seenConnections.push(connection);
      return waitForAbort(signal);
    },
  };
  const probe = new WechatProbe({ client, storage, renderQr: () => 'data:image/svg+xml;base64,bW9jaw==' });
  try {
    await probe.login();
    await waitFor(() => saveStarted);
    await assert.rejects(probe.forget(), { code: 'PROBE_STATE', message: '操作进行中，请稍后重试。' });
    releaseWrite();
    await waitFor(() => !probe.busy);
    await probe.forget();
    assert.equal(probe.session, null);
    assert.equal(probe.phase, 'idle');
    assert.equal(probe.listening, false);
    assert.ok(seenConnections.every(Boolean));
    assert.equal(stored, null);
  } finally {
    releaseWrite?.();
    await probe.stop();
  }
});

function pollingFixture({ response, error, cursor = 'synthetic-saved-cursor' }) {
  const publicStates = [], saved = [];
  let calls = 0;
  const client = {
    notify: async () => {},
    async getUpdates(_session, { signal }) {
      calls += 1;
      if (calls === 1) {
        if (error) throw error;
        return response;
      }
      return waitForAbort(signal);
    },
  };
  const storage = { read: async () => ({ version: 1, session: syntheticSession, cursor }),
    write: async value => saved.push(structuredClone(value)),
    writeStatus: async status => publicStates.push(structuredClone(status)) };
  const probe = new WechatProbe({ client, storage, renderQr: () => '', now: () => Date.parse('2026-10-05T02:00:00Z') });
  return { probe, publicStates, saved };
}

test('restored listener publishes listening before a successful empty or cursor-only poll without claiming a context', async () => {
  for (const cursor of ['synthetic-saved-cursor', 'synthetic-next-cursor']) {
    const f = pollingFixture({ response: { ret: 0, msgs: [], get_updates_buf: cursor } });
    try {
      await f.probe.initialize();
      assert.equal(f.publicStates[0].listening, true);
      await waitFor(() => f.probe.status().lastPoll);
      assert.deepEqual(f.probe.status().lastPoll, { state: 'ok', at: '2026-10-05T02:00:00.000Z',
        messageCount: 0, pairedCount: 0, contextCount: 0 });
      assert.equal(f.probe.status().hasContext, false);
      assert.doesNotMatch(f.probe.message, /已建立微信会话/);
      assert.equal(f.publicStates.at(-1).lastPoll.state, 'ok');
    } finally { await f.probe.stop(); }
  }
});

test('poll counters distinguish foreign messages, paired user messages and valid contexts without disclosing them', async () => {
  const f = pollingFixture({ response: { ret: 0, get_updates_buf: 'synthetic-next-cursor', msgs: [
    { from_user_id: 'synthetic-foreign-user', message_type: 1, context_token: 'synthetic-private-foreign-context' },
    { from_user_id: syntheticSession.userId, message_type: 2, context_token: 'synthetic-private-bot-context' },
    { from_user_id: syntheticSession.userId, message_type: 1 },
    { from_user_id: syntheticSession.userId, message_type: 1, context_token: 'synthetic-private-paired-context', text: 'synthetic-private-message' },
  ] } });
  try {
    await f.probe.initialize();
    await waitFor(() => f.probe.status().lastPoll);
    assert.deepEqual(f.probe.status().lastPoll, { state: 'ok', at: '2026-10-05T02:00:00.000Z',
      messageCount: 4, pairedCount: 2, contextCount: 1 });
    assert.equal(f.probe.status().hasContext, true);
    assert.equal(f.saved.at(-1).contextToken, 'synthetic-private-paired-context');
    const publicText = JSON.stringify(f.publicStates);
    for (const value of [syntheticSession.token, syntheticSession.userId, 'synthetic-foreign-user', 'synthetic-private'])
      assert.ok(!publicText.includes(value));
  } finally { await f.probe.stop(); }
});

test('failed polling publishes safe diagnostics without fictitious empty-message counts', async () => {
  const f = pollingFixture({ error: Object.assign(new Error('synthetic-private-error'), {
    code: 'WECHAT_REJECTED', businessCode: -7, responseRet: -7, responseErrcode: 0, httpStatus: 403, responseHint: 'other',
    errmsg: 'synthetic-private-errmsg', token: 'synthetic-private-token', body: 'synthetic-private-body',
  }) });
  try {
    await f.probe.initialize();
    await waitFor(() => f.probe.status().lastPoll);
    assert.deepEqual(f.probe.status().lastPoll, { state: 'error', at: '2026-10-05T02:00:00.000Z',
      code: 'WECHAT_REJECTED', businessCode: -7, responseRet: -7, responseErrcode: 0, httpStatus: 403, responseHint: 'other' });
    assert.equal(f.publicStates.at(-1).lastPoll.state, 'error');
    assert.equal(f.probe.status().hasContext, false);
    assert.ok(!JSON.stringify(f.publicStates).includes('synthetic-private'));
  } finally { await f.probe.stop(); }
});

test('long-poll timeout is waiting and never proves a server response or an empty message set', async () => {
  const f = pollingFixture({ response: { ret: 0, msgs: [], get_updates_buf: 'synthetic-saved-cursor', pollOutcome: 'timeout' } });
  try {
    await f.probe.initialize();
    await waitFor(() => f.probe.status().lastPoll);
    assert.deepEqual(f.probe.status().lastPoll, { state: 'waiting', at: '2026-10-05T02:00:00.000Z' });
    assert.equal(f.publicStates.at(-1).lastPoll.state, 'waiting');
    assert.equal(f.probe.status().hasContext, false);
    assert.equal(f.saved.length, 0);
  } finally { await f.probe.stop(); }
});
