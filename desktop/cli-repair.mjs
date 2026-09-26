import { readFile, rename, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { probeCodex } from './diagnostics.mjs';

export async function repairCodexPath(configPath, script, { probe = probeCodex } = {}) {
  const path = resolve(script);
  const result = await probe(path);
  if (!result.ok) throw new Error(result.message);
  // 先验证再保存，失败时继续使用原配置；其余账号和渠道信息保持原值。
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  config.codexScript = path;
  const temporary = `${configPath}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  await rename(temporary, configPath);
  return { message: `Codex 路径已更新。${result.message}` };
}
