import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { parseLocalWechatHelperArguments, readLocalWechatInput, runLocalWechatClient } from './wechat-local-client-runtime.mjs';
import { notifyCli, parseNotifyArguments } from '../scripts/wechat-official/notify.mjs';

const request = { id: 'isolated-01', title: '模拟标题', text: '模拟内容' };
const clientFile = join(tmpdir(), 'synthetic-client.bin');
const privateClient = { version: 1, kind: 'wechat-local-client', clientId: 'test-agent', token: 'a'.repeat(43),
  discoveryPath: join(tmpdir(), 'synthetic-public-gateway.json') };
const crypto = { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'test-only',
  decryptString: (buffer) => buffer.toString('utf8').replace(/^encrypted-mock:/, '') };

test('UTF8 stdin tolerates a BOM and rejects extra fields, malformed data and oversized streams', async () => {
  const bytes = Buffer.from('\uFEFF' + JSON.stringify(request), 'utf8');
  assert.deepEqual(await readLocalWechatInput(Readable.from([bytes.subarray(0, 5), bytes.subarray(5)])), request);
  for (const input of ['not JSON', JSON.stringify({ ...request, token: 'extra' }), 'x'.repeat(16385)])
    await assert.rejects(readLocalWechatInput(Readable.from([Buffer.from(input)])));
});

test('headless runtime decrypts locally and never returns the local bearer or real provider details', async () => {
  const result = await runLocalWechatClient({ clientFile, request, crypto,
    readFileImpl: async (path) => path === clientFile
      ? Buffer.from('encrypted-mock:' + JSON.stringify(privateClient))
      : Buffer.from(JSON.stringify({ version: 1, endpoint: 'http://127.0.0.1:41234' })),
    fetchImpl: async (_url, options) => {
      assert.equal(options.headers.Authorization, `Bearer ${privateClient.token}`);
      return new Response(JSON.stringify({ id: request.id, state: 'accepted', code: 'WECHAT_ACCEPTED', token: privateClient.token }));
    } });
  assert.deepEqual(result, { id: request.id, state: 'accepted', code: 'WECHAT_ACCEPTED' });
  assert.equal(JSON.stringify(result).includes(privateClient.token), false);
});

test('missing OS encryption, basic_text, broken blob and provider token exports fail before transport', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; throw new Error('unexpected'); };
  for (const settings of [
    { crypto: { isEncryptionAvailable: () => false } },
    { crypto: { ...crypto, getSelectedStorageBackend: () => 'basic_text' } },
    { crypto, readFileImpl: async () => { throw new Error('private file path'); } },
    { crypto, readFileImpl: async () => Buffer.from('not encrypted JSON') },
    { crypto, readFileImpl: async () => Buffer.from(JSON.stringify({ ...privateClient, kind: 'wechat-bot-session' })) },
  ]) {
    const result = await runLocalWechatClient({ clientFile, request, fetchImpl, ...settings });
    assert.equal(result.code, 'WECHAT_LOCAL_CREDENTIALS');
    assert.equal(result.unsent, true);
  }
  assert.equal(calls, 0);
});

test('CLI status is read-only; message input is not part of the argument parser', async () => {
  assert.deepEqual(parseNotifyArguments(['--client-file', clientFile, '--status']), { clientFile, mode: 'status' });
  assert.deepEqual(parseLocalWechatHelperArguments(['--client-file', clientFile, '--status']), { clientFile, mode: 'status' });
  for (const argv of [[], ['--client-file', clientFile], ['--client-file', clientFile, '--status', '--stdin'],
    ['--client-file', clientFile, '--stdin', '--text', 'forbidden']]) assert.throws(() => parseNotifyArguments(argv));
  let invocation;
  const result = await notifyCli({ argv: ['--client-file', clientFile, '--stdin'],
    input: Readable.from([Buffer.from(JSON.stringify(request))]), resolveElectron: () => 'mock-electron.exe',
    invoke: async (options) => { invocation = options; return { id: request.id, state: 'accepted', code: 'WECHAT_ACCEPTED' }; } });
  assert.deepEqual(invocation.request, request);
  assert.equal(invocation.electronPath, 'mock-electron.exe');
  assert.equal(result.state, 'accepted');
});
