import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { repairCodexPath } from './cli-repair.mjs';

test('修复 CLI 路径需先连接成功，并保留其他提醒配置', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codex-path-repair-'));
  const path = join(directory, 'config.json');
  const config = { codexScript: 'old', desktop: { enabled: false }, reminders: { custom: '保留' } };
  try {
    await writeFile(path, JSON.stringify(config));
    await assert.rejects(repairCodexPath(path, 'missing', { probe: async () => ({ ok: false, message: '请先登录' }) }), /请先登录/);
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), config);
    await repairCodexPath(path, 'new-codex', { probe: async () => ({ ok: true, message: '连接成功' }) });
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { ...config, codexScript: resolve('new-codex') });
  } finally { await rm(directory, { recursive: true, force: true }); }
});
