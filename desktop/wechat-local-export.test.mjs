import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exportLocalWechatClient, decodeLocalWechatBundle, prepareLocalWechatClientProfile } from './wechat-local-export.mjs';

test('Windows client bundle preserves only OS-encrypted profile key and helper writes only isolated Local State', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'wechat-client-export-test-'));
  t.after(() => rm(directory, { force: true, recursive: true }));
  const windowsKey = Buffer.from('DPAPIconstructed-encrypted-key').toString('base64');
  const localState = JSON.stringify({ os_crypt: { encrypted_key: windowsKey }, privateExtra: 'must-not-export' });
  await writeFile(join(directory, 'Local State'), localState);
  const crypto = { isEncryptionAvailable: () => true, encryptString: () => Buffer.from('v10mock-only-encrypted') };
  const client = { version: 1, token: 'must-not-export-plaintext' };
  const bundle = await exportLocalWechatClient(client, { crypto, userData: directory, platform: 'win32' });
  assert.doesNotMatch(bundle.toString(), /must-not-export/);
  assert.equal(decodeLocalWechatBundle(bundle).windowsKey, windowsKey);
  const file = join(directory, 'client.bin'); await writeFile(file, bundle);
  const helperProfile = await mkdtemp(join(directory, 'isolated-'));
  await prepareLocalWechatClientProfile(file, helperProfile, { platform: 'win32' });
  assert.deepEqual(JSON.parse(await readFile(join(helperProfile, 'Local State'), 'utf8')), { os_crypt: { encrypted_key: windowsKey } });
  assert.equal(await readFile(join(directory, 'Local State'), 'utf8'), localState);
});

test('bundle refuses basic_text, malformed key envelope and oversized cipher strings', async () => {
  await assert.rejects(exportLocalWechatClient({}, { crypto: { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'basic_text' }, platform: 'linux' }));
  for (const data of [JSON.stringify({ version: 1, kind: 'wechat-local-encrypted', data: 'not-base64!' }),
    JSON.stringify({ version: 1, kind: 'wechat-local-encrypted', data: 'a'.repeat(32769) }),
    JSON.stringify({ version: 2, kind: 'wechat-local-encrypted', data: 'AAAA' })]) assert.throws(() => decodeLocalWechatBundle(Buffer.from(data)));
});
