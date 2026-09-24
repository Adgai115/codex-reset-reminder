import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { showNotification } from './check.mjs';
import { sendFeishuReminder } from './feishu.mjs';

const directory = dirname(fileURLToPath(import.meta.url));
const channels = new Set(process.argv.slice(2));
const result = {};

if (![...channels].every((channel) => ['desktop', 'feishu'].includes(channel)) || !channels.size) {
  console.error('用法：test-reminder.mjs desktop [feishu]');
  process.exitCode = 2;
} else {
  const expiresAt = Math.floor(Date.now() / 1000) + 7 * 86400;
  const card = { id: `TEST-${randomUUID()}`, title: '【测试】重置卡到期提醒', expiresAt };
  const expiry = new Date(expiresAt * 1000).toLocaleString('zh-CN', { hour12: false });
  const work = [];
  if (channels.has('desktop')) {
    work.push(showNotification({ cardName: card.title, creditId: card.id, expiresLocal: expiry,
      days: 7, simulated: true, autoCloseSeconds: 90 })
      .then(() => { result.desktop = 'sent'; })
      .catch((error) => { result.desktop = `failed: ${error.message}`; }));
  }
  if (channels.has('feishu')) {
    work.push(readFile(join(directory, 'config.json'), 'utf8')
      .then((text) => JSON.parse(text))
      .then((config) => sendFeishuReminder({ ...config, feishu: { ...config.feishu, enabled: true } },
        card, 7, { simulation: true }))
      .then(() => { result.feishu = 'sent'; })
      .catch((error) => { result.feishu = `failed: ${error.message}`; }));
  }
  await Promise.all(work);
  console.log(JSON.stringify(result));
  if (Object.values(result).some((value) => value !== 'sent')) process.exitCode = 1;
}
