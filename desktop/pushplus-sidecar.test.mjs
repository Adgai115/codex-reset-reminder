import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

test('sidecar submits WeChat without a Token crossing IPC, records acceptance and keeps account isolation',
  { timeout: 20000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codex-pushplus-rpc-'));
  const configPath = join(directory, 'config.json');
  const config = { codexScript: 'mock', desktop: { enabled: false }, feishu: { enabled: false },
    wechat: { enabled: true, provider: 'pushplus', credentialId: '00000000-0000-4000-8000-000000000001' },
    reminders: { quietHours: { enabled: false } } };
  await writeFile(configPath, JSON.stringify(config));
  let identity = 'a@example.invalid';
  const identities = new Map();
  const sent = [];
  let transportUnknown = false;
  let consumeCalls = 0;
  let nextId = 1;
  let child;
  let lines;
  const pending = new Map();
  let resolveReady;
  let rejectReady;
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const expiry = Math.floor(Date.now() / 1000) + 7 * 86400 - 60;
  const write = (payload) => child.stdin.write(`${JSON.stringify(payload)}\n`);
  const request = (op, args = {}) => new Promise((resolve, reject) => {
    const id = nextId++; pending.set(id, { resolve, reject }); write({ id, op, args });
  });
  try {
    child = spawn(process.execPath, [fileURLToPath(new URL('./core-worker.mjs', import.meta.url))], {
      windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, CODEX_RESET_MONITOR_DATA_DIR: directory, CODEX_RESET_MONITOR_CONFIG_PATH: configPath },
    });
    child.stderr.resume();
    child.on('error', rejectReady);
    child.on('exit', () => { rejectReady(new Error('worker stopped')); for (const p of pending.values()) p.reject(new Error('worker stopped')); });
    lines = readline.createInterface({ input: child.stdout });
    lines.on('line', (line) => {
      const message = JSON.parse(line);
      if (message.type === 'ready') resolveReady();
      else if (message.type === 'result') {
        const p = pending.get(message.id); pending.delete(message.id);
        if (message.ok) p.resolve(message.result); else p.reject(new Error(message.error));
      } else if (message.type === 'account') {
        const scope = message.args.scopeId || message.args.binding?.scopeId;
        let result = true;
        if (message.action === 'capture') identities.set(scope, identity);
        if (message.action === 'request') {
          if (message.args.method === 'account/read') result = { account: { type: 'chatgpt', email: identities.get(scope) || identity } };
          else if (message.args.method === 'account/rateLimits/read') result = { rateLimitResetCredits: {
            availableCount: 1, credits: [{ id: 'same-official-id', title: '模拟官方卡', status: 'available', expiresAt: expiry }] } };
          else if (message.args.method === 'account/rateLimitResetCredit/consume') consumeCalls++;
        }
        write({ type: 'account-result', eventId: message.eventId, ok: true, result });
      } else if (message.type === 'wechat') {
        sent.push(message);
        write(transportUnknown
          ? { type: 'wechat-result', eventId: message.eventId, ok: false, error: '结果待核实', code: 'PUSHPLUS_UNKNOWN' }
          : { type: 'wechat-result', eventId: message.eventId, ok: true,
            result: { ok: true, confirmation: 'accepted', messageId: `fixture-receipt-${sent.length}` } });
      }
    });
    await ready;
    const a = await request('checkAccount');
    await request('syncCards', { scopeId: a.scopeId });
    identity = 'b@example.invalid';
    const b = await request('checkAccount');
    await request('syncCards', { scopeId: b.scopeId });
    assert.notEqual(a.scopeId, b.scopeId);
    await request('runReminders');
    assert.equal(sent.length, 2);
    for (const message of sent) {
      assert.equal(Object.hasOwn(message.payload, 'token'), false);
      assert.equal(Object.hasOwn(message.config.wechat, 'token'), false);
      assert.equal(message.config.wechat.credentialId, config.wechat.credentialId);
      assert.match(message.payload.content, /模拟官方卡/);
    }
    assert.ok(sent.some((message) => message.payload.content.includes('a***@example.invalid')));
    assert.ok(sent.some((message) => message.payload.content.includes('b***@example.invalid')));
    await request('runReminders');
    assert.equal(sent.length, 2, 'accepted nodes are not posted twice');
    const db = new DatabaseSync(join(directory, 'data.db'));
    try {
      const rows = db.prepare("SELECT state, confirmation FROM reminder_attempts WHERE channel = 'wechat'").all();
      assert.equal(rows.length, 2);
      assert.ok(rows.every((row) => row.state === 'sent' && row.confirmation === 'accepted'));
      assert.equal(db.prepare('SELECT COUNT(DISTINCT account_scope_id) AS n FROM cards').get().n, 2);
    } finally { db.close(); }
    transportUnknown = true;
    const later = expiry - 3 * 86400 + 60;
    await request('runReminders', { nowSeconds: later });
    assert.equal(sent.length, 4);
    await request('runReminders', { nowSeconds: later + 3600 });
    assert.equal(sent.length, 4, 'uncertain replies are not automatically submitted again');
    const snapshot = await request('manageSnapshot', { scopeId: a.scopeId });
    const unknown = snapshot.cards.flatMap((card) => card.deliveryResults).find((row) => row.errorCode === 'pushplus_unknown');
    assert.ok(unknown, 'public unknown classification survives transport IPC');
    assert.equal(unknown.nextRetryAt, null);
    assert.equal(unknown.retryable, false);
    assert.equal(consumeCalls, 0);
    assert.deepEqual(JSON.parse(await readFile(configPath, 'utf8')), config);
  } finally {
    if (child && child.exitCode === null) {
      const exited = new Promise((resolve) => child.once('close', resolve));
      child.stdin.end(); child.kill(); await exited;
    }
    lines?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
