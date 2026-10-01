import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { createMockCodex } from './mock-codex.mjs';
import { codexCommand } from '../core/native-bin.mjs';

test('parallel mock accounts keep every request log without terminating a CLI', { timeout: 120000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'codex-mock-concurrent-'));
  try {
    const started = Date.now();
    const mock = await createMockCodex(directory);
    t.diagnostic(`isolated mock compilation: ${Date.now() - started} ms`);
    await writeFile(join(directory, 'auth.json'), JSON.stringify({ mockProfile: directory.replaceAll('\\', '/') }));
    await writeFile(join(directory, 'mock-account.json'), JSON.stringify({ account: { type: 'chatgpt', email: 'fixture@example.invalid' } }));
    const command = codexCommand(mock);
    const outcomes = await Promise.allSettled(Array.from({ length: 16 }, () => new Promise((resolve, reject) => {
      const child = spawn(command.executable, command.prefix, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, CODEX_HOME: directory } });
      let output = ''; child.stdout.on('data', (data) => { output += data; }); child.stderr.resume();
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; child.kill(); }, 20000);
      child.once('error', reject); child.stdin.on('error', () => {});
      child.once('close', (code) => { clearTimeout(timer);
        resolve({ code, timedOut, responses: output.trim().split(/\r?\n/).filter(Boolean).map(JSON.parse) }); });
      child.stdin.end(Array.from({ length: 20 }, (_, id) => JSON.stringify({ id, method: 'account/read' }) + '\n').join(''));
    })));
    for (const settled of outcomes) {
      assert.equal(settled.status, 'fulfilled');
      const outcome = settled.value;
      assert.equal(outcome.timedOut, false, 'mock CLI exceeded its independent deadline');
      assert.equal(outcome.code, 0);
      assert.equal(outcome.responses.length, 20);
      assert.ok(outcome.responses.every((response) => response.result?.account?.email === 'fixture@example.invalid'));
    }
    assert.equal((await readFile(join(directory, 'mock-requests.log'), 'utf8')).trim().split(/\r?\n/).length, 320);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
