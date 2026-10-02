import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { accountErrorPayload, restoreCoreError, resetFailureResult } from './error-protocol.mjs';

test('account errors preserve request uncertainty without disclosing vendor messages', () => {
  const source = new Error('private vendor response');
  source.code = 'ACCOUNT_LOGIN_REQUIRED';
  source.afterRequest = true;
  const payload = accountErrorPayload(source);
  assert.equal(JSON.stringify(payload).includes(source.message), false);
  const restored = restoreCoreError(JSON.parse(JSON.stringify(payload)));
  assert.equal(restored.afterRequest, true);
  assert.equal(restored.code, 'ACCOUNT_LOGIN_REQUIRED');
  const invalid = accountErrorPayload({ code: 'private/path', afterRequest: 'true' });
  assert.equal(invalid.code, undefined);
  assert.equal(restoreCoreError(invalid).afterRequest, false);
});

test('reset feedback separates a blocked request from an uncertain submitted request', () => {
  const blocked = Object.assign(new Error('card changed'), { code: 'ACCOUNT_CARD_CHANGED' });
  assert.equal(resetFailureResult(restoreCoreError(accountErrorPayload(blocked))).outcome, 'blocked');
  const submitted = Object.assign(new Error('identity check failed'), {
    code: 'ACCOUNT_UNAVAILABLE', afterRequest: true,
  });
  assert.equal(resetFailureResult(restoreCoreError(accountErrorPayload(submitted))).outcome, 'unconfirmed');
  assert.equal(resetFailureResult(new Error('connection dropped')).outcome, 'unconfirmed');
});

test('PushPlus transport retains only its public error codes across the sidecar boundary', () => {
  assert.equal(restoreCoreError({ error: '结果待核实', code: 'PUSHPLUS_UNKNOWN' }).code, 'PUSHPLUS_UNKNOWN');
  assert.equal(restoreCoreError({ error: 'unknown', code: 'PRIVATE_TOKEN' }).code, undefined);
});

test('sidecar retains the after-request flag through a simulated reset failure', { timeout: 15000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'codex-rpc-boundary-'));
  const configPath = join(directory, 'config.json');
  writeFileSync(configPath, JSON.stringify({ codexScript: 'mock', desktop: { enabled: false },
    feishu: { enabled: false }, quietHours: { enabled: false } }));
  const child = spawn(process.execPath, [fileURLToPath(new URL('./core-worker.mjs', import.meta.url))], {
    windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, CODEX_RESET_MONITOR_DATA_DIR: directory,
      CODEX_RESET_MONITOR_CONFIG_PATH: configPath },
  });
  const lines = readline.createInterface({ input: child.stdout });
  child.stderr.resume();
  const pending = new Map();
  let nextId = 1;
  let readyResolve;
  const ready = new Promise((resolve) => { readyResolve = resolve; });
  const expiry = Math.floor(Date.now() / 1000) + 86400;
  let resets = 0;
  const write = (payload) => child.stdin.write(`${JSON.stringify(payload)}\n`);
  lines.on('line', (line) => {
    const message = JSON.parse(line);
    if (message.type === 'ready') readyResolve();
    else if (message.type === 'result') {
      const request = pending.get(message.id);
      pending.delete(message.id);
      if (message.ok) request.resolve(message.result); else request.reject(restoreCoreError(message));
    } else if (message.type === 'account') {
      let result = true;
      if (message.action === 'request') {
        if (message.args.method === 'account/read') result = { account: { type: 'chatgpt', email: 'fixture@example.invalid' } };
        else if (message.args.method === 'account/rateLimits/read') result = {
          rateLimitResetCredits: { availableCount: 1, credits: [{ id: 'fixture-card', title: '模拟卡',
            status: 'available', expiresAt: expiry }] },
        };
        else if (message.args.method === 'account/rateLimitResetCredit/consume') {
          resets++;
          const failure = Object.assign(new Error('private vendor response'), {
            code: 'ACCOUNT_LOGIN_REQUIRED', afterRequest: true,
          });
          write({ type: 'account-result', eventId: message.eventId, ok: false, ...accountErrorPayload(failure) });
          return;
        }
      }
      write({ type: 'account-result', eventId: message.eventId, ok: true, result });
    }
  });
  const exited = new Promise((resolve) => child.once('close', resolve));
  const request = (op, args = {}) => new Promise((resolve, reject) => {
    const id = nextId++; pending.set(id, { resolve, reject }); write({ id, op, args });
  });
  try {
    await ready;
    const account = await request('checkAccount');
    await request('syncCards', { scopeId: account.scopeId });
    await assert.rejects(request('resetCardFromReminder', { cardId: 'fixture-card', expectedExpiresAt: expiry }),
      (error) => error.afterRequest === true && error.code === 'ACCOUNT_LOGIN_REQUIRED'
        && !error.message.includes('private vendor'));
    assert.equal(resets, 1, 'only the simulated provider receives a reset request');
  } finally {
    child.stdin.end(); child.kill(); await exited; lines.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
