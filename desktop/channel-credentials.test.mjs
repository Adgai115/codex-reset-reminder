import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { commitWechatSettings, readWechatToken, wechatSettingsStatus } from './channel-credentials.mjs';

// 模拟系统加密与隔离磁盘；所有 Token 均为测试构造值。
const crypto = {
  isEncryptionAvailable: () => true,
  getSelectedStorageBackend: () => 'mock-keychain',
  encryptString: (value) => Buffer.from(Buffer.from(value).map((byte) => byte ^ 0x91)),
  decryptString: (value) => Buffer.from(value.map((byte) => byte ^ 0x91)).toString('utf8'),
};
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'codex-pushplus-vault-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const configPath = join(directory, 'config.json');
  return { configPath, vault: join(directory, 'channels', 'credentials'),
    save: (value) => writeFile(configPath, JSON.stringify(value)) };
}

test('Token is encrypted on disk; config and settings expose a reference and status only', async (t) => {
  const { configPath, vault, save } = await fixture(t);
  const token = 'constructed-pushplus-test-token';
  await commitWechatSettings(configPath, { desktop: { enabled: true }, future: { keep: true } },
    { wechatEnabled: true, wechatToken: token }, save, { crypto });
  const raw = await readFile(configPath, 'utf8');
  const config = JSON.parse(raw);
  assert.equal(raw.includes(token), false);
  assert.equal(config.wechat.enabled, true);
  assert.equal(config.wechat.provider, 'pushplus');
  assert.match(config.wechat.credentialId, /^[0-9a-f-]{36}$/);
  assert.deepEqual(config.future, { keep: true });
  const files = await readdir(vault);
  assert.equal(files.length, 1);
  assert.equal((await readFile(join(vault, files[0]))).includes(Buffer.from(token)), false);
  assert.equal(await readWechatToken(configPath, config, { crypto }), token);
  assert.deepEqual(await wechatSettingsStatus(configPath, config),
    { wechatEnabled: true, wechatConfigured: true, wechatProvider: 'pushplus' });
});

test('blank Token keeps saved credential across disable and reenable without rewrites', async (t) => {
  const { configPath, vault, save } = await fixture(t);
  await commitWechatSettings(configPath, {}, { wechatEnabled: true, wechatToken: 'constructed-original' }, save, { crypto });
  const original = JSON.parse(await readFile(configPath, 'utf8'));
  await commitWechatSettings(configPath, original, { wechatEnabled: false, wechatToken: '' }, save);
  const disabled = JSON.parse(await readFile(configPath, 'utf8'));
  assert.equal(disabled.wechat.credentialId, original.wechat.credentialId);
  assert.equal(disabled.wechat.enabled, false);
  await commitWechatSettings(configPath, disabled, { wechatEnabled: true, wechatToken: '  ' }, save);
  const enabled = JSON.parse(await readFile(configPath, 'utf8'));
  assert.equal(enabled.wechat.credentialId, original.wechat.credentialId);
  assert.equal(enabled.wechat.enabled, true);
  assert.equal((await readdir(vault)).length, 1);
});

test('failed preference commit removes only candidate and preserves original credential', async (t) => {
  const { configPath, vault, save } = await fixture(t);
  await commitWechatSettings(configPath, {}, { wechatEnabled: true, wechatToken: 'constructed-original' }, save, { crypto });
  const originalText = await readFile(configPath, 'utf8');
  const original = JSON.parse(originalText);
  const originalFiles = await readdir(vault);
  await assert.rejects(commitWechatSettings(configPath, original,
    { wechatEnabled: true, wechatToken: 'constructed-replacement' }, async () => { throw new Error('preference commit rejected'); },
    { crypto }), /preference commit rejected/);
  assert.equal(await readFile(configPath, 'utf8'), originalText);
  assert.deepEqual(await readdir(vault), originalFiles);
  assert.equal(await readWechatToken(configPath, original, { crypto }), 'constructed-original');
});

test('successful credential replacement cleans the old file only after config is committed', async (t) => {
  const { configPath, vault, save } = await fixture(t);
  await commitWechatSettings(configPath, {}, { wechatEnabled: true, wechatToken: 'constructed-original' }, save, { crypto });
  const original = JSON.parse(await readFile(configPath, 'utf8'));
  await commitWechatSettings(configPath, original, { wechatEnabled: true, wechatToken: 'constructed-replacement' },
    async (value) => {
      assert.equal((await readdir(vault)).length, 2);
      assert.equal(await readWechatToken(configPath, original, { crypto }), 'constructed-original');
      await save(value);
    }, { crypto });
  const replaced = JSON.parse(await readFile(configPath, 'utf8'));
  assert.notEqual(replaced.wechat.credentialId, original.wechat.credentialId);
  assert.equal((await readdir(vault)).length, 1);
  assert.equal(await readWechatToken(configPath, replaced, { crypto }), 'constructed-replacement');
});

test('old public-account fields survive unchanged when no PushPlus input is selected', async (t) => {
  const { configPath, save } = await fixture(t);
  const legacy = { wechat: { enabled: true, templateId: 'mock-template', openId: 'mock-recipient' } };
  await commitWechatSettings(configPath, legacy, {}, save);
  assert.deepEqual(JSON.parse(await readFile(configPath, 'utf8')), legacy);
  await commitWechatSettings(configPath, legacy, { wechatEnabled: false, wechatToken: '' }, save);
  assert.deepEqual(JSON.parse(await readFile(configPath, 'utf8')), legacy);
  assert.deepEqual(await wechatSettingsStatus(configPath, legacy),
    { wechatEnabled: true, wechatConfigured: false, wechatProvider: 'legacy' });
  let written = false;
  await assert.rejects(commitWechatSettings(configPath, legacy, { wechatEnabled: true, wechatToken: '' },
    async () => { written = true; }), /先填写并保存/);
  assert.equal(written, false);
});

test('unavailable and plaintext storage cannot persist or decrypt a Token', async (t) => {
  const { configPath, vault, save } = await fixture(t);
  const unavailable = { ...crypto, isEncryptionAvailable: () => false };
  const plaintext = { ...crypto, getSelectedStorageBackend: () => 'basic_text' };
  for (const unsafe of [unavailable, plaintext, undefined]) {
    await assert.rejects(commitWechatSettings(configPath, {}, { wechatEnabled: true, wechatToken: 'constructed-token' }, save,
      { crypto: unsafe }), /系统凭据保护不可用/);
  }
  await assert.rejects(readdir(vault), { code: 'ENOENT' });
  await commitWechatSettings(configPath, {}, { wechatEnabled: true, wechatToken: 'constructed-token' }, save, { crypto });
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  await assert.rejects(readWechatToken(configPath, config, { crypto: plaintext }),
    { message: '系统凭据保护不可用，请解锁系统钥匙串后重试', code: 'PUSHPLUS_CONFIGURATION' });
});

test('invalid references and unreadable files never expose contents or enable missing credentials', async (t) => {
  const { configPath, save } = await fixture(t);
  const invalid = { wechat: { enabled: true, provider: 'pushplus', credentialId: '../unsafe' } };
  assert.equal((await wechatSettingsStatus(configPath, invalid)).wechatConfigured, false);
  await assert.rejects(readWechatToken(configPath, invalid, { crypto }), /^Error: 微信 Token 无法读取/);
  await assert.rejects(commitWechatSettings(configPath, invalid, { wechatEnabled: true, wechatToken: '' }, save), /先填写并保存/);
  await commitWechatSettings(configPath, {}, { wechatEnabled: true, wechatToken: 'constructed-token' }, save, { crypto });
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  const path = join(dirname(configPath), 'channels', 'credentials', `pushplus-${config.wechat.credentialId}.bin`);
  await writeFile(path, 'corrupt-test-secret');
  await assert.rejects(readWechatToken(configPath, config, { crypto }), (error) => {
    assert.equal(error.message, '微信 Token 无法读取，请重新保存');
    assert.equal(error.code, 'PUSHPLUS_CONFIGURATION');
    assert.equal(error.message.includes('corrupt-test-secret'), false);
    return true;
  });
});

test('invalid Token input and encrypted-file write failure keep configuration untouched', async (t) => {
  const { configPath, vault, save } = await fixture(t);
  await save({ keep: true });
  for (const token of ['invalid\ninternal', 'x'.repeat(257), 123]) {
    await assert.rejects(commitWechatSettings(configPath, { keep: true }, { wechatEnabled: true, wechatToken: token }, save,
      { crypto }), /有效的 PushPlus Token/);
  }
  await writeFile(join(dirname(configPath), 'channels'), 'simulated-directory-collision');
  await assert.rejects(commitWechatSettings(configPath, { keep: true }, { wechatEnabled: true, wechatToken: 'constructed-token' }, save,
    { crypto }), /Token 未保存/);
  assert.deepEqual(JSON.parse(await readFile(configPath, 'utf8')), { keep: true });
  await assert.rejects(readdir(vault));
});
