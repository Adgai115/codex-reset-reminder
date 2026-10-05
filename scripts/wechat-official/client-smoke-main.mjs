import { app, safeStorage } from 'electron';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { invokeWechatLocalClient } from '../../core/wechat-local-client.mjs';
import { exportLocalWechatClient } from '../../desktop/wechat-local-export.mjs';

// A real Electron keychain round trip against loopback mocks only. This script
// never reads the authorization profile or contacts a WeChat service.
const directory = await mkdtemp(join(tmpdir(), 'codex-wechat-client-smoke-'));
app.setName('Codex 微信直连验证');
app.setPath('userData', join(directory, 'electron'));
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
let server, code = 1, stage = 'ENCRYPTION';
const executableIndex = process.argv.indexOf('--electron-path');
const electronPath = executableIndex >= 0 ? process.argv[executableIndex + 1] : process.execPath;
try {
  assert.equal(safeStorage.isEncryptionAvailable(), true);
  assert.notEqual(safeStorage.getSelectedStorageBackend?.(), 'basic_text');
  let sends = 0;
  const token = randomBytes(32).toString('base64url');
  server = createServer(async (incoming, outgoing) => {
    assert.equal(incoming.headers.authorization, `Bearer ${token}`);
    let result;
    if (incoming.method === 'GET' && incoming.url === '/v1/status') {
      result = { state: 'status', code: 'WECHAT_LOCAL_STATUS', running: true, queued: 0, sending: false,
        client: { id: 'isolated-client', label: '模拟 client' }, receipts: [], capacity: { clients: 8, receipts: 100 } };
    } else {
      assert.equal(incoming.method, 'POST'); assert.equal(incoming.url, '/v1/notify');
      let body = ''; for await (const chunk of incoming) body += chunk.toString('utf8');
      const request = JSON.parse(body);
      assert.equal(request.text, '中文模拟内容，只有本机 mock 收到。');
      sends++;
      result = { id: request.id, state: 'accepted', code: 'WECHAT_ACCEPTED', privateIgnored: token };
    }
    outgoing.writeHead(200, { 'Content-Type': 'application/json' }); outgoing.end(JSON.stringify(result));
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const discoveryPath = join(directory, 'gateway.json');
  await writeFile(discoveryPath, JSON.stringify({ version: 1, endpoint: `http://127.0.0.1:${server.address().port}` }));
  const clientFile = join(directory, 'agent.bin');
  stage = 'EXPORT';
  await writeFile(clientFile, await exportLocalWechatClient({ version: 1, kind: 'wechat-local-client',
    clientId: 'isolated-client', token, discoveryPath }, { crypto: safeStorage, userData: app.getPath('userData') }), { mode: 0o600 });
  const request = { id: 'isolated-client-smoke-01', title: '模拟提醒', text: '中文模拟内容，只有本机 mock 收到。' };
  stage = 'SEND';
  const sentResult = await invokeWechatLocalClient({ electronPath, clientFile, request });
  if (sentResult.state !== 'accepted') process.stderr.write(`WECHAT_CLIENT_SMOKE_RESULT ${sentResult.state}/${sentResult.code}\n`);
  assert.deepEqual(sentResult,
    { id: request.id, state: 'accepted', code: 'WECHAT_ACCEPTED' });
  stage = 'STATUS';
  const status = await invokeWechatLocalClient({ electronPath, clientFile, mode: 'status' });
  assert.equal(status.state, 'status'); assert.equal(sends, 1);
  assert.equal(JSON.stringify(status).includes(token), false);
  process.stdout.write('WECHAT_CLIENT_SMOKE_OK\n');
  code = 0;
} catch { process.stderr.write(`WECHAT_CLIENT_SMOKE_FAILED_${stage}\n`); }
finally {
  await new Promise((resolve) => server ? server.close(resolve) : resolve());
  await rm(directory, { recursive: true, force: true }).catch(() => {});
  app.exit(code);
}
});
