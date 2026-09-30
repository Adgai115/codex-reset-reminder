import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createCodexSession } from './codex-session.mjs';

test('an absent CLI rejects requests and closes promptly without an orphaned wait', { timeout: 3000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'codex-session-absent-'));
  let exited = 0;
  const session = createCodexSession(join(directory, 'absent-codex.exe'), {
    home: directory, timeoutMs: 500, onExit: () => exited++,
  });
  try {
    await assert.rejects(session.request('account/read', {}), /连接已中断/);
    await Promise.race([session.close(), new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error('failed spawn cleanup took too long')), 800);
      timer.unref();
    })]);
    assert.equal(exited, 1);
    await assert.rejects(session.request('account/read', {}));
  } finally { await session.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('a CLI exiting during initialization rejects queued requests once and can be closed twice', { timeout: 3000 }, async () => {
  let exited = 0;
  // Node is an isolated failing stand-in: app-server is not a script here.
  const session = createCodexSession(process.execPath, { timeoutMs: 1000, onExit: () => exited++ });
  await assert.rejects(session.request('account/read', {}), /连接已中断/);
  await session.close(); await session.close();
  assert.equal(exited, 1);
});
