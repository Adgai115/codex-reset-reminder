import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { invokeWechatLocalClient } from './wechat-local-client.mjs';

const request = { id: 'mock-job-01', title: '模拟', text: '不会发送真实消息。' };
const options = { electronPath: 'synthetic-electron.exe', clientFile: join(tmpdir(), 'mock-client.bin'), request };
const accepted = { id: request.id, state: 'accepted', code: 'WECHAT_ACCEPTED' };
function makeChild() {
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.killed = false; child.kill = () => { child.killed = true; };
  return child;
}

test('subprocess receives private file reference and message stdin; no shell or Node Electron override', async () => {
  const prior = process.env.ELECTRON_RUN_AS_NODE;
  process.env.ELECTRON_RUN_AS_NODE = '1';
  let body = '';
  try {
    const result = await invokeWechatLocalClient({ ...options, spawnImpl: (executable, argv, spawnOptions) => {
      assert.equal(executable, options.electronPath);
      assert.ok(argv.includes('--wechat-local-client-helper'));
      assert.ok(argv.includes(options.clientFile));
      assert.equal(argv.some((value) => value.includes(request.text)), false);
      assert.equal(spawnOptions.env.ELECTRON_RUN_AS_NODE, undefined);
      assert.equal(spawnOptions.shell, false);
      assert.equal(spawnOptions.windowsHide, true);
      const child = makeChild();
      child.stdin.on('data', (chunk) => { body += chunk.toString('utf8'); });
      child.stdin.on('finish', () => {
        child.stderr.write('private native diagnostic');
        child.stdout.write(JSON.stringify({ ...accepted, token: 'not-allowed' }));
        child.emit('close', 0);
      });
      return child;
    } });
    assert.deepEqual(JSON.parse(body), request);
    assert.deepEqual(result, accepted);
  } finally { if (prior === undefined) delete process.env.ELECTRON_RUN_AS_NODE; else process.env.ELECTRON_RUN_AS_NODE = prior; }
});

test('invalid arguments and pre-abort do not spawn; spawn failure is clearly unsent', async () => {
  let calls = 0;
  const spawnImpl = () => { calls++; throw new Error('private path'); };
  assert.equal((await invokeWechatLocalClient({ ...options, clientFile: 'relative.bin', spawnImpl })).code, 'WECHAT_LOCAL_CONFIGURATION');
  const cancelled = new AbortController(); cancelled.abort();
  assert.equal((await invokeWechatLocalClient({ ...options, signal: cancelled.signal, spawnImpl })).code, 'WECHAT_LOCAL_CANCELLED');
  assert.equal(calls, 0);
  const result = await invokeWechatLocalClient({ ...options, spawnImpl });
  assert.equal(result.code, 'WECHAT_LOCAL_HELPER_UNAVAILABLE');
  assert.equal(result.unsent, true);
});

test('helper crash, oversized output, and timeout never trigger a second send', async () => {
  for (const failure of ['crash', 'output', 'timeout']) {
    let calls = 0, child;
    const result = await invokeWechatLocalClient({ ...options, timeoutMs: 5, spawnImpl: () => {
      calls++; child = makeChild();
      queueMicrotask(() => {
        if (failure === 'crash') child.emit('close', 1);
        if (failure === 'output') child.stdout.write('x'.repeat(16385));
      });
      return child;
    } });
    assert.equal(result.code, 'WECHAT_UNKNOWN');
    assert.equal(calls, 1);
    if (failure !== 'crash') assert.equal(child.killed, true);
  }
});

test('pre-transport helper rejection remains unsent, even with nonzero child exit', async () => {
  const result = await invokeWechatLocalClient({ ...options, spawnImpl: () => {
    const child = makeChild();
    queueMicrotask(() => {
      child.stdout.write(JSON.stringify({ state: 'unsent', code: 'WECHAT_LOCAL_CREDENTIALS', privateMessage: 'hidden' }));
      child.emit('close', 1);
    });
    return child;
  } });
  assert.deepEqual(result, { id: request.id, state: 'unsent', code: 'WECHAT_LOCAL_CREDENTIALS', unsent: true });
});
