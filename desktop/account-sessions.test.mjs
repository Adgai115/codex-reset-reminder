import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createAccountSessions } from './account-sessions.mjs';

function protector() {
  const key = randomBytes(32);
  return { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'test-protected',
    encryptString(input) { const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', key, iv);
      const data = Buffer.concat([cipher.update(input), cipher.final()]); return Buffer.concat([iv, cipher.getAuthTag(), data]); },
    decryptString(input) { const decipher = createDecipheriv('aes-256-gcm', key, input.subarray(0, 12));
      decipher.setAuthTag(input.subarray(12, 28)); return Buffer.concat([decipher.update(input.subarray(28)), decipher.final()]).toString(); } };
}
const binding = (id, email) => ({ scopeId: id, emailHash: createHash('sha256').update(`${id}\0${email}`).digest('hex'), workspaceHash: null });
const identity = (email) => ({ account: { type: 'chatgpt', email } });

test('encrypted account sessions survive restart, refresh separately and leave source login untouched', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codex-vault-'));
  const sourceHome = join(directory, 'source'); await mkdir(sourceHome);
  const crypto = protector();
  const createSession = (_script, { home }) => ({
    async request(method) {
      const auth = JSON.parse(await readFile(join(home, 'auth.json'), 'utf8'));
      if (method === 'account/read') return identity(auth.email);
      await writeFile(join(home, 'auth.json'), JSON.stringify({ ...auth, refreshed: true }));
      return { owner: auth.email, refreshed: auth.refreshed || false };
    }, close: async () => {} });
  let sessions = createAccountSessions({ directory, crypto, createSession, sourceHome });
  try {
    const first = JSON.stringify({ email: 'alpha@example.invalid', secret: 'fake-first-secret' });
    await writeFile(join(sourceHome, 'auth.json'), first);
    await sessions.capture({ binding: binding('first', 'alpha@example.invalid'), script: 'mock' });
    const second = JSON.stringify({ email: 'beta@example.invalid', secret: 'fake-second-secret' });
    await writeFile(join(sourceHome, 'auth.json'), second);
    await sessions.capture({ binding: binding('second', 'beta@example.invalid'), script: 'mock' });
    await sessions.request({ scopeId: 'first', script: 'mock', method: 'account/rateLimits/read' });
    await sessions.close();
    sessions = createAccountSessions({ directory, crypto, createSession, sourceHome });
    assert.deepEqual(await sessions.request({ scopeId: 'first', script: 'mock', method: 'account/rateLimits/read' }),
      { owner: 'alpha@example.invalid', refreshed: true });
    assert.equal((await sessions.request({ scopeId: 'second', script: 'mock', method: 'account/read' })).account.email, 'beta@example.invalid');
    assert.equal(await readFile(join(sourceHome, 'auth.json'), 'utf8'), second);
    const encrypted = await readFile(join(directory, 'accounts', 'credentials', 'first.bin'));
    assert.equal(encrypted.includes(Buffer.from('fake-first-secret')), false);
    assert.equal(encrypted.includes(Buffer.from('alpha@example.invalid')), false);
    assert.deepEqual(await readdir(join(directory, 'accounts', 'runtime')), []);
    await assert.rejects(sessions.capture({ binding: binding('first', 'alpha@example.invalid'), script: 'mock' }), /登录已变化/);
    assert.equal((await sessions.request({ scopeId: 'first', script: 'mock', method: 'account/read' })).account.email, 'alpha@example.invalid');
    await assert.rejects(sessions.request({ scopeId: '../escape', script: 'mock', method: 'account/read' }), /需要重新登录/);
  } finally { await sessions.close(); await rm(directory, { recursive: true, force: true }); }
});

test('missing secure storage never saves an unprotected account session', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codex-vault-disabled-'));
  const sessions = createAccountSessions({ directory, crypto: { isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => 'basic_text', encryptString: () => { throw new Error('must not encrypt'); } },
    sourceHome: join(directory, 'missing'), createSession: () => { throw new Error('must not start'); } });
  try {
    assert.deepEqual(await sessions.capture({ binding: binding('first', 'alpha@example.invalid'), script: 'mock' }),
      { saved: false, reason: 'secure_storage_unavailable' });
    await assert.rejects(sessions.startLogin({ script: 'mock' }), /凭据保护不可用/);
    assert.deepEqual(await readdir(join(directory, 'accounts', 'credentials')), []);
  } finally { await sessions.close(); await rm(directory, { recursive: true, force: true }); }
});

test('browser login can be cancelled; late completion cannot save credentials', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codex-login-'));
  let notify;
  const sessions = createAccountSessions({ directory, crypto: protector(), sourceHome: directory,
    createSession: (_script, options) => { notify = options.onNotification;
      return { request: async () => ({ type: 'chatgpt', authUrl: 'https://auth.openai.com/authorize?fake=simulation' }), close: async () => {} }; },
    openLogin: async () => {} });
  let completions = 0;
  try {
    await sessions.startLogin({ script: 'mock', onComplete: () => { completions++; } });
    assert.equal(sessions.status().state, 'waiting');
    await assert.rejects(sessions.startLogin({ script: 'mock' }), /已有账号/);
    await sessions.cancelLogin();
    notify('account/login/completed', { success: true });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(completions, 0);
    assert.equal(sessions.status().state, 'idle');
    assert.deepEqual(await readdir(join(directory, 'accounts', 'runtime')), []);
  } finally { await sessions.close(); await rm(directory, { recursive: true, force: true }); }
});

test('logging into a different identity cannot replace an existing protected account', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codex-login-identity-'));
  const sourceHome = join(directory, 'source'); await mkdir(sourceHome);
  await writeFile(join(sourceHome, 'auth.json'), JSON.stringify({ email: 'alpha@example.invalid', secret: 'fake-original' }));
  let notify;
  let loginHome;
  const sessions = createAccountSessions({ directory, crypto: protector(), sourceHome,
    createSession: (_script, options) => {
      if (options.onNotification) { notify = options.onNotification; loginHome = options.home; }
      return { async request(method) {
        if (method === 'account/login/start') {
          await writeFile(join(options.home, 'auth.json'), JSON.stringify({ email: 'beta@example.invalid', secret: 'fake-wrong' }));
          return { type: 'chatgpt', authUrl: 'https://auth.openai.com/authorize?fake=simulation' };
        }
        return identity(JSON.parse(await readFile(join(options.home, 'auth.json'), 'utf8')).email);
      }, close: async () => {} };
    }, openLogin: async () => {} });
  try {
    const original = binding('first', 'alpha@example.invalid');
    await sessions.capture({ binding: original, script: 'mock' });
    const protectedBefore = await readFile(join(directory, 'accounts', 'credentials', 'first.bin'));
    await sessions.startLogin({ script: 'mock', expectedScopeId: 'first', onComplete: (args) => sessions.loginRequest({ ...args, binding: original }) });
    notify('account/login/completed', { success: true });
    for (let i = 0; i < 100 && sessions.status().state === 'waiting'; i++) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(sessions.status().state, 'failed');
    assert.deepEqual(await readFile(join(directory, 'accounts', 'credentials', 'first.bin')), protectedBefore);
    assert.equal((await sessions.request({ scopeId: 'first', script: 'mock', method: 'account/read' })).account.email, 'alpha@example.invalid');
    await assert.rejects(readFile(join(loginHome, 'auth.json')), { code: 'ENOENT' });
  } finally { await sessions.close(); await rm(directory, { recursive: true, force: true }); }
});

test('successful browser login stays independent when CLI changes or captures the same account again', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codex-login-independent-'));
  const sourceHome = join(directory, 'source'); await mkdir(sourceHome);
  const source = JSON.stringify({ email: 'beta@example.invalid', secret: 'fake-cli-secret' });
  await writeFile(join(sourceHome, 'auth.json'), source);
  let notify;
  const sessions = createAccountSessions({ directory, crypto: protector(), sourceHome,
    createSession: (_script, options) => {
      if (options.onNotification) notify = options.onNotification;
      return { async request(method) {
        if (method === 'account/login/start') {
          await writeFile(join(options.home, 'auth.json'), JSON.stringify({ email: 'alpha@example.invalid', secret: 'fake-browser-secret' }));
          return { type: 'chatgpt', authUrl: 'https://auth.openai.com/authorize?fake=simulation' };
        }
        return identity(JSON.parse(await readFile(join(options.home, 'auth.json'), 'utf8')).email);
      }, close: async () => {} };
    }, openLogin: async () => {} });
  try {
    const first = binding('first', 'alpha@example.invalid');
    await sessions.startLogin({ script: 'mock', onComplete: (args) => sessions.loginRequest({ ...args, binding: first }) });
    notify('account/login/completed', { success: true });
    for (let i = 0; i < 100 && sessions.status().state === 'waiting'; i++) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(sessions.status().state, 'complete');
    assert.equal(await sessions.has('first'), true);
    await sessions.capture({ binding: first, script: 'mock' });
    assert.equal((await sessions.request({ scopeId: 'first', useCurrent: true, script: 'mock', method: 'account/read' })).account.email,
      'alpha@example.invalid', 'independent browser session is used even if a mutable CLI session is marked current');
    assert.equal(await readFile(join(sourceHome, 'auth.json'), 'utf8'), source);
    assert.deepEqual(await readdir(join(directory, 'accounts', 'runtime')), []);
  } finally { await sessions.close(); await rm(directory, { recursive: true, force: true }); }
});
