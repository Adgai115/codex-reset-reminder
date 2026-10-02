import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProbeStorage } from './storage.mjs';

const crypto = { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'test_backend',
  encryptString: value => Buffer.from(value, 'utf8').map(byte => byte ^ 0x57),
  decryptString: value => Buffer.from(value).map(byte => byte ^ 0x57).toString('utf8') };
test('isolated storage encrypts credentials and writes only allowlisted receipt metadata', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wechat-storage-'));
  try {
    const store = createProbeStorage(directory, crypto);
    const data = { version: 1, session: { token: 'synthetic-secret-never-real' }, contextToken: 'private-context' };
    await store.write(data);
    assert.deepEqual(await store.read(), data);
    assert.ok(!(await readFile(join(directory, 'session.bin'))).includes(Buffer.from(data.session.token)));
    await store.writeStatus({ phase: 'login', qrDataUrl: 'private-qr', token: 'private-token', contextToken: 'private-context',
      scheduled: null, tests: [{ id: 'mock-test', label: '即时测试', at: '2026-10-02T08:00:00Z', confirmation: 'accepted', rawMessage: 'private-text' }] });
    const plain = await readFile(join(directory, 'status.json'), 'utf8');
    assert.ok(plain.includes('accepted'));
    for (const value of ['private-qr', 'private-token', 'private-context', 'private-text']) assert.ok(!plain.includes(value));
    assert.deepEqual((await readdir(directory)).sort(), ['session.bin', 'status.json']);
    await store.remove(); assert.equal(await store.read(), null);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('storage refuses unavailable or plaintext system credential encryption', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wechat-storage-'));
  try {
    for (const backend of [{ ...crypto, isEncryptionAvailable: () => false }, { ...crypto, getSelectedStorageBackend: () => 'basic_text' }]) {
      const store = createProbeStorage(directory, backend);
      await assert.rejects(store.write({ version: 1 }), /加密/);
      assert.deepEqual(await readdir(directory), []);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
