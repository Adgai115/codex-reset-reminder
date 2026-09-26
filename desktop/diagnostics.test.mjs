import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { diagnoseLocal, probeCodex } from './diagnostics.mjs';

test('diagnosis reads Usage without exposing credentials or mutating cards', async () => {
  const calls = [];
  const result = await probeCodex('codex-fixture', { exists: () => true,
    appServer: async (path, method) => {
      calls.push([path, method]);
      return { rateLimitResetCredits: { availableCount: 2, credits: [{}, {}] } };
    } });
  assert.deepEqual(calls, [['codex-fixture', 'account/rateLimits/read']]);
  assert.deepEqual(result, { ok: true, complete: true, availableCount: 2,
    message: 'Codex Usage 可读取，当前可用 2 张重置卡。' });
  assert.equal((await probeCodex('missing', { exists: () => false })).ok, false);
});

test('local diagnosis separates saved Feishu configuration from listener health', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'codex-reset-diagnostics-'));
  try {
    const codex = join(dir, 'codex.js');
    const lark = join(dir, 'lark.js');
    const configPath = join(dir, 'config.json');
    await writeFile(codex, '');
    await writeFile(lark, '');
    await writeFile(configPath, JSON.stringify({ codexScript: codex, larkCliScript: lark,
      feishu: { enabled: true, profile: 'test', userId: 'ou_test', appSecret: 'do-not-expose' } }));
    const result = await diagnoseLocal(configPath, { state: 'occupied' });
    assert.equal(result.feishu, '飞书配置已保存');
    assert.match(result.listener, /占用/);
    assert.ok(!JSON.stringify(result).includes('do-not-expose'));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
