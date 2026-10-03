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
