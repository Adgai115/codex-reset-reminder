import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sendFeishuReminder } from './feishu.mjs';

const directory = dirname(fileURLToPath(import.meta.url));
try {
  const config = JSON.parse(await readFile(join(directory, 'config.json'), 'utf8'));
  if (!config.feishu?.enabled) throw new Error('请先运行 setup-feishu.ps1');
  const card = { id: 'SIMULATION-CARD', title: '【测试】演示重置卡',
    expiresAt: Math.floor(Date.now() / 1000) + 7 * 86400 };
  await sendFeishuReminder(config, card, 7, { simulation: true });
  console.log('飞书测试消息已发送；未使用真实重置卡。');
} catch (error) { console.error(error.message); process.exitCode = 1; }
