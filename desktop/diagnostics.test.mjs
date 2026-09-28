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
      return { rateLimitResetCredits: { availableCount: 2, credits: [
        { id: 'one', status: 'available', expiresAt: 100 },
        { id: 'two', status: 'available', expiresAt: 200 },
      ] } };
    } });
  assert.deepEqual(calls, [['codex-fixture', 'account/rateLimits/read']]);
  assert.deepEqual(result, { ok: true, complete: true, availableCount: 2, detailedCount: 2,
    message: 'Codex 已连接，2 张卡的到期详情已核对。' });
  assert.equal((await probeCodex('missing', { exists: () => false })).ok, false);
});

test('连接成功但官方只返回数量时如实说明详情缺失', async () => {
  const result = await probeCodex('codex-fixture', { exists: () => true,
    appServer: async () => ({ rateLimitResetCredits: { availableCount: 3, credits: null } }) });
  assert.equal(result.ok, true);
  assert.equal(result.complete, false);
  assert.equal(result.detailedCount, 0);
  assert.match(result.message, /官方暂未提供逐卡到期详情/);
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
