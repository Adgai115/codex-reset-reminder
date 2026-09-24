import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sendFeishuReminder } from './feishu.mjs';
import { addManualCard, latestCompleteSync, listCards, openStore, recordDelivery, recordFeishuMessage } from './store.mjs';

const directory = dirname(fileURLToPath(import.meta.url));
try {
  const config = JSON.parse(await readFile(join(directory, 'config.json'), 'utf8'));
  if (!config.feishu?.enabled || !config.feishu.userId) throw new Error('飞书机器人私聊尚未配置');
  const expiresAt = Math.floor(Date.now() / 1000) + 7 * 86400;
  const useRealCard = process.argv.includes('--real');
  const db = openStore();
  let id;
  let title;
  let source;
  let reportedUsedAt = null;
  let currentAvailableCount = null;
  let actualExpiresAt = expiresAt;
  try {
    if (useRealCard) {
      const card = listCards(db, true).filter((item) => item.source === 'codex' && item.status === 'available')
        .sort((a, b) => a.expiresAt - b.expiresAt)[0];
      if (!card) throw new Error('本地没有可用的 Codex 重置卡，先运行 sync.mjs');
      ({ id, title, source, expiresAt: actualExpiresAt, reportedUsedAt } = card);
      currentAvailableCount = latestCompleteSync(db)?.availableCount ?? null;
    } else {
      title = '【测试】演示重置卡（只改本地状态）';
      source = 'manual';
      id = addManualCard(db, { title, expiresAt });
    }
  } finally { db.close(); }
  const sendDays = useRealCard ? 7 : Math.max(1, Math.ceil((actualExpiresAt - Math.floor(Date.now() / 1000)) / 86400));
  const sent = await sendFeishuReminder(config, { id, title, source, status: 'available',
    reportedUsedAt, expiresAt: actualExpiresAt }, sendDays, { currentAvailableCount });
  const mapping = openStore();
  try { recordFeishuMessage(mapping, { messageId: sent.messageId, cardId: id, expiresAt: actualExpiresAt,
    thresholdDays: sendDays, recipientOpenId: config.feishu.userId });
    if (!useRealCard) {
      recordDelivery(mapping, id, actualExpiresAt, sendDays, 'feishu');
      recordDelivery(mapping, id, actualExpiresAt, sendDays, 'desktop');
    } }
  finally { mapping.close(); }
  console.log(JSON.stringify({ testCardId: id, messageId: sent.messageId,
    mode: useRealCard ? 'real-codex-card' : 'safe-manual-simulation',
    note: useRealCard ? '点击立即使用并二次确认后会调用 Codex 正式用卡接口。'
      : '安全演示：点击已使用只会更新本地手动卡，不调用 Codex。' }));
} catch (error) { console.error(error.message); process.exitCode = 1; }
