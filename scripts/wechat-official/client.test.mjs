import test from 'node:test';
import assert from 'node:assert/strict';
import { createWechatClient, DEFAULT_BASE_URL, safeWechatBaseUrl } from './client.mjs';

const session = { token: 'mock-bot-token', baseUrl: DEFAULT_BASE_URL, userId: 'mock-user' };
function mockClient(payload, options = {}) {
  const calls = [];
  return { calls, client: createWechatClient({ ...options, fetchImpl: async (url, init) => {
    calls.push({ url, init });
    if (payload instanceof Error) throw payload;
    return payload instanceof Response ? payload : Response.json(payload);
  } }) };
}
function errorCode(code) {
  return error => {
    assert.equal(error.code, code);
    assert.doesNotMatch(error.message, /mock-bot-token|server-secret|evil\.example/);
    assert.equal(error.cause, undefined);
    return true;
  };
}

test('official origin validation rejects credentials, foreign domains and malformed base paths', () => {
  assert.equal(safeWechatBaseUrl(`${DEFAULT_BASE_URL}/`), DEFAULT_BASE_URL);
  assert.equal(safeWechatBaseUrl('https://ilinkai.weixin.qq.com:443'), DEFAULT_BASE_URL);
  assert.equal(safeWechatBaseUrl('https://sub.weixin.qq.com'), 'https://sub.weixin.qq.com');
  for (const value of ['http://ilinkai.weixin.qq.com', 'https://evil.example',
    'https://ilinkai.weixin.qq.com.evil.example', 'https://evilweixin.qq.com',
    'https://user:server-secret@ilinkai.weixin.qq.com', 'https://ilinkai.weixin.qq.com:8443',
    'https://ilinkai.weixin.qq.com/path', 'https://ilinkai.weixin.qq.com/./',
    'https://ilinkai.weixin.qq.com?token=server-secret', 'https://ilinkai.weixin.qq.com/?',
    'https://ilinkai.weixin.qq.com/#', 'https://ilinkai.weixin.qq.com\n',
    'https://ilinkai.weixin.qq.com\\@evil.example', 'https://ilinkai.weixin.qq.com.']) {
    assert.throws(() => safeWechatBaseUrl(value), errorCode('WECHAT_CONFIGURATION'));
  }
});

test('QR creation follows official POST protocol without existing account credentials', async () => {
  const { client, calls } = mockClient({ qrcode: 'mock-qr-value',
    qrcode_img_content: 'https://ilinkai.weixin.qq.com/qr?value=mock' });
  assert.deepEqual(await client.requestQr(), { qrcode: 'mock-qr-value',
    qrcode_img_content: 'https://ilinkai.weixin.qq.com/qr?value=mock' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${DEFAULT_BASE_URL}/ilink/bot/get_bot_qrcode?bot_type=3`);
  assert.deepEqual(JSON.parse(calls[0].init.body), { local_token_list: [] });
  assert.equal(calls[0].init.headers.Authorization, undefined);
  assert.equal(calls[0].init.headers.AuthorizationType, 'ilink_bot_token');
  assert.equal(calls[0].init.headers['iLink-App-Id'], 'bot');
  assert.equal(calls[0].init.headers['iLink-App-ClientVersion'], String(0x00020409));
  assert.match(Buffer.from(calls[0].init.headers['X-WECHAT-UIN'], 'base64').toString(), /^\d+$/);
  assert.equal(calls[0].init.redirect, 'error');
});

test('QR content must be an official HTTPS URL and business errors are checked', async () => {
  for (const image of ['https://evil.example/qr?server-secret', 'http://ilinkai.weixin.qq.com/qr',
    'https://server-secret@ilinkai.weixin.qq.com/qr', 'data:image/png;base64,mock']) {
    const { client } = mockClient({ qrcode: 'mock-qr-value', qrcode_img_content: image });
    await assert.rejects(client.requestQr(), errorCode('WECHAT_PROTOCOL'));
  }
  const { client } = mockClient({ ret: -7, errmsg: 'server-secret' });
  await assert.rejects(client.requestQr(), error => errorCode('WECHAT_REJECTED')(error)
    && error.businessCode === -7);
});

test('QR polling handles verification and checks redirected or confirmed origins', async () => {
  const { client, calls } = mockClient({ status: 'confirmed', bot_token: 'mock-new-token',
    ilink_user_id: 'mock-user', ilink_bot_id: 'mock-bot', baseurl: `${DEFAULT_BASE_URL}/` });
  const result = await client.pollQr('mock-qr&value', { verifyCode: '1234' });
  assert.equal(result.status, 'confirmed');
  assert.equal(result.baseurl, DEFAULT_BASE_URL);
  assert.equal(result.bot_token, 'mock-new-token');
  const url = new URL(calls[0].url);
  assert.equal(url.searchParams.get('qrcode'), 'mock-qr&value');
  assert.equal(url.searchParams.get('verify_code'), '1234');
  assert.equal(calls[0].init.method, 'GET');
  assert.equal(calls[0].init.headers.Authorization, undefined);
  const redirect = mockClient({ status: 'scaned_but_redirect', redirect_host: 'route.weixin.qq.com' });
  assert.equal((await redirect.client.pollQr('mock-qr')).redirectBaseUrl, 'https://route.weixin.qq.com');
  for (const payload of [
    { status: 'confirmed', bot_token: 'mock', ilink_user_id: 'mock', baseurl: 'https://evil.example' },
    { status: 'confirmed', ilink_user_id: 'mock', baseurl: DEFAULT_BASE_URL },
    { status: 'confirmed', bot_token: 'mock', baseurl: DEFAULT_BASE_URL },
    { status: 'confirmed', bot_token: 'mock', ilink_user_id: 'mock' },
    { status: 'scaned_but_redirect', redirect_host: 'evil.example' },
    { status: 'scaned_but_redirect', redirect_host: 'http://route.weixin.qq.com' },
    { status: 'scaned_but_redirect', redirect_host: 'server-secret@route.weixin.qq.com' },
    { status: 'scaned_but_redirect' }, { status: 'unrecognized-server-secret' },
  ]) {
    await assert.rejects(mockClient(payload).client.pollQr('mock-qr'), errorCode('WECHAT_PROTOCOL'));
  }
});

test('updates preserve conversation context and text while removing media', async () => {
  const { client, calls } = mockClient({ ret: 0, get_updates_buf: 'mock-next-cursor',
    longpolling_timeout_ms: 35000, msgs: [{ from_user_id: 'mock-user', to_user_id: 'mock-bot',
      context_token: 'mock-context', message_type: 1, message_id: '18446744073709551615',
      item_list: [{ type: 1, text_item: { text: '测试' } },
        { type: 2, image_item: { url: 'https://evil.example/server-secret' } }] }] });
  const result = await client.getUpdates(session, { cursor: 'mock-current-cursor' });
  assert.equal(result.get_updates_buf, 'mock-next-cursor');
  assert.equal(result.msgs[0].context_token, 'mock-context');
  assert.equal(result.msgs[0].message_id, '18446744073709551615');
  assert.deepEqual(result.msgs[0].item_list, [{ type: 1, text_item: { text: '测试' } }]);
  assert.equal(calls[0].init.headers.Authorization, 'Bearer mock-bot-token');
  assert.equal(JSON.parse(calls[0].init.body).get_updates_buf, 'mock-current-cursor');
  assert.equal(calls[0].init.redirect, 'error');
});

test('updates require an explicit successful ret and a valid message array', async () => {
  for (const payload of [{ msgs: [] }, { ret: '0', msgs: [] }, { ret: 0 },
    { ret: 0, msgs: {} }, { ret: 0, msgs: [null] }, { ret: 0, msgs: [], get_updates_buf: {} },
    { ret: 0, msgs: [], errcode: 'server-secret' }]) {
    await assert.rejects(mockClient(payload).client.getUpdates(session), errorCode('WECHAT_PROTOCOL'));
  }
  for (const payload of [{ ret: -14 }, { ret: 0, errcode: -14, msgs: [] }]) {
    await assert.rejects(mockClient(payload).client.getUpdates(session), errorCode('WECHAT_SESSION_EXPIRED'));
  }
});

test('numeric uint64 message IDs survive parsing without modifying message text', async () => {
  const raw = '{"ret":0,"msgs":[{"message_id":18446744073709551615,"from_user_id":"mock-user",'
    + '"context_token":"mock-context","item_list":[{"type":1,"text_item":'
    + '{"text":"\\\"message_id\\\":18446744073709551615"}}]}],"get_updates_buf":""}';
  const result = await mockClient(new Response(raw)).client.getUpdates(session);
  assert.equal(result.msgs[0].message_id, '18446744073709551615');
  assert.equal(result.msgs[0].context_token, 'mock-context');
  assert.equal(result.msgs[0].item_list[0].text_item.text, '"message_id":18446744073709551615');
});

test('text send submits once with explicit or omitted context and only reports accepted', async () => {
  const { client, calls } = mockClient({ ret: 0, message_id: 'mock-message' });
  assert.deepEqual(await client.sendText(session, { text: '隔离验证', contextToken: 'mock-context', clientId: 'mock-id' }),
    { ok: true, confirmation: 'accepted', clientId: 'mock-id' });
  assert.equal(calls.length, 1);
  const payload = JSON.parse(calls[0].init.body);
  assert.equal(payload.msg.context_token, 'mock-context');
  assert.equal(payload.msg.to_user_id, 'mock-user');
  assert.equal(payload.msg.message_type, 2);
  assert.equal(payload.msg.message_state, 2);
  assert.deepEqual(payload.msg.item_list, [{ type: 1, text_item: { text: '隔离验证' } }]);
  assert.equal(payload.base_info.channel_version, '2.4.9');
  assert.equal(payload.base_info.bot_agent, 'CodexResetReminderProbe/1.0');
  const noContext = mockClient({ ret: 0 });
  await noContext.client.sendText(session, { text: '隔离验证' });
  assert.equal(Object.hasOwn(JSON.parse(noContext.calls[0].init.body).msg, 'context_token'), false);
});

test('send network errors, redirects, HTTP errors and missing ret are unknown without retry or leaked errors', async () => {
  for (const payload of [new Error('server-secret https://evil.example/mock-bot-token'),
    {}, { errcode: 0 }, { ret: null }, { ret: '0' },
    new Response('server-secret', { status: 302, headers: { Location: 'https://evil.example' } }),
    new Response('server-secret', { status: 500 }), new Response('server-secret', { status: 200 })]) {
    const { client, calls } = mockClient(payload);
    await assert.rejects(client.sendText(session, { text: '隔离验证' }), errorCode('WECHAT_UNKNOWN'));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].init.redirect, 'error');
  }
});

test('send checks ret and errcode including expired sessions without retry', async () => {
  for (const payload of [{ ret: -2, errmsg: 'server-secret' }, { ret: 0, errcode: -2 }]) {
    const { client, calls } = mockClient(payload);
    await assert.rejects(client.sendText(session, { text: '隔离验证' }), error =>
      errorCode('WECHAT_REJECTED')(error) && error.businessCode === -2);
    assert.equal(calls.length, 1);
  }
  await assert.rejects(mockClient({ ret: -14 }).client.sendText(session, { text: '隔离验证' }),
    errorCode('WECHAT_SESSION_EXPIRED'));
});

test('invalid session origins and send arguments are rejected before a request', async () => {
  const { client, calls } = mockClient({ ret: 0 });
  for (const input of [{ ...session, baseUrl: 'https://evil.example' },
    { ...session, token: 'mock\nserver-secret' }, { ...session, userId: '' }]) {
    await assert.rejects(client.sendText(input, { text: '隔离验证' }), errorCode('WECHAT_CONFIGURATION'));
  }
  for (const args of [{ text: '' }, { text: ' '.repeat(30) }, { text: '好'.repeat(3000) },
    { text: '测试', clientId: 'bad\nserver-secret' }, { text: '测试', contextToken: '' }]) {
    await assert.rejects(client.sendText(session, args), errorCode('WECHAT_CONFIGURATION'));
  }
  assert.equal(calls.length, 0);
});

test('timeouts bound fetches even when transport ignores abort and sends remain unknown', async () => {
  let calls = 0;
  const client = createWechatClient({ timeoutMs: 10, fetchImpl: async () => {
    calls += 1;
    return new Promise(() => {});
  } });
  await assert.rejects(client.requestQr(), errorCode('WECHAT_TIMEOUT'));
  await assert.rejects(client.sendText(session, { text: '隔离验证' }), errorCode('WECHAT_UNKNOWN'));
  assert.equal(calls, 2);
});

test('cancelled reads stop promptly and cancellation before dispatch sends nothing', async () => {
  const before = new AbortController();
  before.abort(new Error('server-secret'));
  const mocked = mockClient({ ret: 0 });
  await assert.rejects(mocked.client.sendText(session, { text: '隔离验证', signal: before.signal }),
    errorCode('WECHAT_CANCELLED'));
  assert.equal(mocked.calls.length, 0);
  const during = new AbortController();
  let calls = 0;
  const client = createWechatClient({ timeoutMs: 1000, fetchImpl: async () => {
    calls += 1;
    queueMicrotask(() => during.abort(new Error('server-secret')));
    return new Promise(() => {});
  } });
  await assert.rejects(client.getUpdates(session, { signal: during.signal }), errorCode('WECHAT_CANCELLED'));
  assert.equal(calls, 1);
});

test('cancelling an in-flight send cannot claim it was not accepted', async () => {
  const controller = new AbortController();
  let calls = 0;
  const client = createWechatClient({ fetchImpl: async () => {
    calls += 1;
    queueMicrotask(() => controller.abort());
    return new Promise(() => {});
  } });
  await assert.rejects(client.sendText(session, { text: '隔离验证', signal: controller.signal }),
    errorCode('WECHAT_UNKNOWN'));
  assert.equal(calls, 1);
});

test('response streaming is bounded and a stalled body is covered by timeout', async () => {
  const tooLarge = new ReadableStream({ start(controller) {
    controller.enqueue(new Uint8Array(1024 * 1024 + 1));
    controller.close();
  } });
  await assert.rejects(mockClient(new Response(tooLarge)).client.requestQr(), errorCode('WECHAT_PROTOCOL'));
  await assert.rejects(mockClient(new Response('{}', { headers: { 'Content-Length': String(2 * 1024 * 1024) } }))
    .client.sendText(session, { text: '隔离验证' }), errorCode('WECHAT_UNKNOWN'));
  const stalled = new ReadableStream({ start() {} });
  assert.deepEqual(await mockClient(new Response(stalled), { longPollTimeoutMs: 10 }).client.getUpdates(session),
    { ret: 0, msgs: [], get_updates_buf: '' });
});

test('long-poll timeout means waiting and preserves the cursor for the next explicit poll', async () => {
  let qrCalls = 0;
  let updateCalls = 0;
  const client = createWechatClient({ longPollTimeoutMs: 10, fetchImpl: async url => {
    if (new URL(url).pathname.endsWith('/get_qrcode_status')) {
      qrCalls += 1;
      if (qrCalls === 1) return new Promise(() => {});
      return Response.json({ status: 'scaned' });
    }
    updateCalls += 1;
    if (updateCalls === 1) return new Promise(() => {});
    return Response.json({ ret: 0, msgs: [], get_updates_buf: 'mock-next-cursor' });
  } });
  assert.deepEqual(await client.pollQr('mock-qr'), { status: 'wait' });
  assert.equal(qrCalls, 1);
  assert.deepEqual(await client.pollQr('mock-qr'), { status: 'scaned' });
  assert.equal(qrCalls, 2);
  assert.deepEqual(await client.getUpdates(session, { cursor: 'mock-cursor' }),
    { ret: 0, msgs: [], get_updates_buf: 'mock-cursor' });
  assert.equal(updateCalls, 1);
  assert.equal((await client.getUpdates(session, { cursor: 'mock-cursor' })).get_updates_buf, 'mock-next-cursor');
  assert.equal(updateCalls, 2);
});

test('long polls use their own timeout rather than the short ordinary request timeout', async () => {
  const client = createWechatClient({ timeoutMs: 1, longPollTimeoutMs: 200, fetchImpl: async url => {
    await new Promise(resolve => setTimeout(resolve, 10));
    return Response.json(new URL(url).pathname.endsWith('/get_qrcode_status')
      ? { status: 'scaned' } : { ret: 0, msgs: [], get_updates_buf: 'mock-cursor' });
  } });
  assert.deepEqual(await client.pollQr('mock-qr'), { status: 'scaned' });
  assert.deepEqual(await client.getUpdates(session), { ret: 0, msgs: [], get_updates_buf: 'mock-cursor' });
});

test('external cancellation of QR long polling remains cancellation instead of waiting', async () => {
  const controller = new AbortController();
  let calls = 0;
  const client = createWechatClient({ longPollTimeoutMs: 1000, fetchImpl: async () => {
    calls += 1;
    queueMicrotask(() => controller.abort());
    return new Promise(() => {});
  } });
  await assert.rejects(client.pollQr('mock-qr', { signal: controller.signal }), errorCode('WECHAT_CANCELLED'));
  assert.equal(calls, 1);
});

test('HTTP and JSON failures are sanitized for read-only requests', async () => {
  const { client } = mockClient(new Response('server-secret https://evil.example', { status: 502 }));
  await assert.rejects(client.requestQr(), error => errorCode('WECHAT_HTTP')(error) && error.httpStatus === 502);
  for (const payload of [new Response('server-secret'), [], null]) {
    await assert.rejects(mockClient(payload).client.requestQr(), errorCode('WECHAT_PROTOCOL'));
  }
  await assert.rejects(mockClient(new Error('server-secret')).client.requestQr(), errorCode('WECHAT_NETWORK'));
});

test('notify checks action and explicit business success', async () => {
  for (const state of ['start', 'stop']) {
    const { client, calls } = mockClient({ ret: 0 });
    assert.deepEqual(await client.notify(session, state), { ok: true });
    assert.equal(calls[0].url, `${DEFAULT_BASE_URL}/ilink/bot/msg/notify${state}`);
    assert.equal(calls[0].init.redirect, 'error');
  }
  await assert.rejects(mockClient({}).client.notify(session, 'start'), errorCode('WECHAT_PROTOCOL'));
  const { client, calls } = mockClient({ ret: 0 });
  await assert.rejects(client.notify(session, 'other'), errorCode('WECHAT_CONFIGURATION'));
  assert.equal(calls.length, 0);
});

test('client configuration is validated without printing supplied values', () => {
  for (const options of [{ timeoutMs: 0 }, { timeoutMs: Infinity }, { timeoutMs: 60001 },
    { longPollTimeoutMs: 0 }, { longPollTimeoutMs: Infinity }, { longPollTimeoutMs: 60001 },
    { version: 'server-secret' }, { version: '256.0.0' }, { fetchImpl: null }]) {
    assert.throws(() => createWechatClient(options), errorCode('WECHAT_CONFIGURATION'));
  }
});
