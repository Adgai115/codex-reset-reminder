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
const deferred = () => { let resolve; let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject }; };

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

test('concurrent browser login requests create only one session and clean up on close', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codex-login-concurrent-'));
  let opened = 0;
  const sessions = createAccountSessions({ directory, crypto: protector(), sourceHome: directory,
    createSession: () => ({ request: async () => ({ type: 'chatgpt', authUrl: 'https://auth.openai.com/authorize?fake=simulation' }),
      close: async () => {} }), openLogin: async () => { opened++; } });
  try {
    const results = await Promise.allSettled([sessions.startLogin({ script: 'mock', onComplete: () => {} }),
      sessions.startLogin({ script: 'mock', onComplete: () => {} })]);
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    assert.match(results.find((result) => result.status === 'rejected').reason.message, /已有账号/);
    assert.equal(opened, 1);
    assert.equal((await readdir(join(directory, 'accounts', 'runtime'))).length, 1);
    await sessions.close();
    assert.deepEqual(await readdir(join(directory, 'accounts', 'runtime')), []);
    await assert.rejects(sessions.startLogin({ script: 'mock', onComplete: () => {} }), /服务已停止/);
  } finally { await sessions.close(); await rm(directory, { recursive: true, force: true }); }
});

test('cancelled completion cannot overwrite the status of a newer login', async () => {
  for (const failed of [false, true]) {
    const directory = await mkdtemp(join(tmpdir(), 'codex-login-stale-completion-'));
    const completion = deferred(); const entered = deferred();
    let notify;
    const sessions = createAccountSessions({ directory, crypto: protector(), sourceHome: directory,
      createSession: (_script, options) => { notify = options.onNotification;
        return { request: async () => ({ type: 'chatgpt', authUrl: 'https://auth.openai.com/authorize?fake=simulation' }),
          close: async () => {} }; } });
    try {
      await sessions.startLogin({ script: 'mock', onComplete: () => { entered.resolve(); return completion.promise; } });
      notify('account/login/completed', { success: true }); await entered.promise;
      await sessions.cancelLogin();
      await sessions.startLogin({ script: 'mock', onComplete: () => {} });
      if (failed) completion.reject(new Error('simulated late failure')); else completion.resolve();
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(sessions.status().state, 'waiting');
      assert.equal((await readdir(join(directory, 'accounts', 'runtime'))).length, 1);
      assert.deepEqual(await readdir(join(directory, 'accounts', 'credentials')), []);
    } finally { completion.resolve(); await sessions.close(); await rm(directory, { recursive: true, force: true }); }
  }
});

test('cancelling while an identity request is pending prevents credential saving', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codex-login-cancel-identity-'));
  const accountRead = deferred(); const entered = deferred(); const completed = deferred();
  let notify;
  const sessions = createAccountSessions({ directory, crypto: protector(), sourceHome: directory,
    createSession: (_script, options) => { notify = options.onNotification;
      return { async request(method) {
        if (method === 'account/login/start') {
          await writeFile(join(options.home, 'auth.json'), JSON.stringify({ email: 'alpha@example.invalid', secret: 'fake-browser-secret' }));
          return { type: 'chatgpt', authUrl: 'https://auth.openai.com/authorize?fake=simulation' };
        }
        entered.resolve(); return accountRead.promise;
      }, close: async () => {} }; } });
  try {
    await sessions.startLogin({ script: 'mock', onComplete: async (args) => {
      try { return await sessions.loginRequest({ ...args, binding: binding('first', 'alpha@example.invalid') }); }
      finally { completed.resolve(); }
    } });
    notify('account/login/completed', { success: true }); await entered.promise;
    await sessions.cancelLogin();
    accountRead.resolve(identity('alpha@example.invalid')); await completed.promise;
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(sessions.status().state, 'idle');
    assert.equal(await sessions.has('first'), false);
    assert.deepEqual(await readdir(join(directory, 'accounts', 'runtime')), []);
  } finally { accountRead.resolve(identity('alpha@example.invalid')); await sessions.close(); await rm(directory, { recursive: true, force: true }); }
});

test('cancelling a login queued behind an account operation preserves its previous session', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codex-login-cancel-queue-'));
  const sourceHome = join(directory, 'source'); await mkdir(sourceHome);
  await writeFile(join(sourceHome, 'auth.json'), JSON.stringify({ email: 'alpha@example.invalid', secret: 'fake-original' }));
  const operation = deferred(); const entered = deferred(); const loginRead = deferred(); const completed = deferred();
  const crypto = protector(); let notify;
  const sessions = createAccountSessions({ directory, crypto, sourceHome,
    createSession: (_script, options) => {
      if (options.onNotification) notify = options.onNotification;
      return { async request(method) {
        if (method === 'account/login/start') {
          await writeFile(join(options.home, 'auth.json'), JSON.stringify({ email: 'alpha@example.invalid', secret: 'fake-browser-new' }));
          return { type: 'chatgpt', authUrl: 'https://auth.openai.com/authorize?fake=simulation' };
        }
        if (method === 'account/rateLimits/read') { entered.resolve(); return operation.promise; }
        if (options.onNotification) loginRead.resolve();
        return identity('alpha@example.invalid');
      }, close: async () => {} };
    } });
  let pending;
  try {
    const first = binding('first', 'alpha@example.invalid');
    await sessions.capture({ binding: first, script: 'mock' });
    pending = sessions.request({ scopeId: 'first', script: 'mock', method: 'account/rateLimits/read' });
    await entered.promise;
    await sessions.startLogin({ script: 'mock', onComplete: async (args) => {
      try { return await sessions.loginRequest({ ...args, binding: first }); }
      finally { completed.resolve(); }
    } });
    notify('account/login/completed', { success: true }); await loginRead.promise;
    await new Promise((resolve) => setImmediate(resolve));
    await sessions.cancelLogin();
    operation.resolve({ rateLimitResetCredits: { availableCount: 0, credits: [] } });
    await pending; await completed.promise; await new Promise((resolve) => setImmediate(resolve));
    assert.equal(sessions.status().state, 'idle');
    const saved = JSON.parse(crypto.decryptString(await readFile(join(directory, 'accounts', 'credentials', 'first.bin'))));
    assert.equal(JSON.parse(saved.auth).secret, 'fake-original');
    assert.deepEqual(await readdir(join(directory, 'accounts', 'runtime')), []);
  } finally { operation.resolve({}); await pending; await sessions.close(); await rm(directory, { recursive: true, force: true }); }
});

test('a successful consume followed by a credential save failure retains the request uncertainty flag', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codex-vault-consume-save-'));
  const sourceHome = join(directory, 'source'); await mkdir(sourceHome);
  await writeFile(join(sourceHome, 'auth.json'), JSON.stringify({ email: 'alpha@example.invalid', secret: 'fake-original' }));
  const crypto = protector(); const encrypt = crypto.encryptString;
  let failSaving = false; let consumeCalls = 0;
  crypto.encryptString = (input) => { if (failSaving) throw new Error('模拟系统加密失败'); return encrypt(input); };
  const sessions = createAccountSessions({ directory, crypto, sourceHome,
    createSession: () => ({ async request(method) {
      if (method === 'account/read') return identity('alpha@example.invalid');
      if (method === 'account/rateLimitResetCredit/consume') { consumeCalls++; return { outcome: 'reset' }; }
      return {};
    }, close: async () => {} }) });
  try {
    await sessions.capture({ binding: binding('first', 'alpha@example.invalid'), script: 'mock' });
    failSaving = true;
    await assert.rejects(sessions.request({ scopeId: 'first', script: 'mock', method: 'account/rateLimitResetCredit/consume' }),
      (error) => error.afterRequest === true && /模拟系统加密失败/.test(error.message));
    assert.equal(consumeCalls, 1);
    assert.deepEqual(await readdir(join(directory, 'accounts', 'runtime')), []);
    assert.equal(await sessions.has('first'), true);
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
