import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { callAppServer } from './check.mjs';
import { patchFeishuCard } from './feishu.mjs';
import { replanScheduledTask } from './replan.mjs';
import { getCard, latestCompleteSync, listPendingFeishuConfirmations, openStore,
  recordSyncFailure, saveCodexSnapshot, setFeishuMessageStatus } from './store.mjs';

const directory = dirname(fileURLToPath(import.meta.url));

export async function syncCards(configPath = join(directory, 'config.json'),
  { appServer = callAppServer, patchCard = patchFeishuCard, patchMessages = true } = {}) {
  const db = openStore();
  try {
    const config = JSON.parse(await readFile(configPath, 'utf8'));
    const response = await appServer(resolve(config.codexScript), 'account/rateLimits/read');
    const result = saveCodexSnapshot(db, response?.rateLimitResetCredits);
    const cardUpdateFailures = [];
    if (patchMessages && config.feishu?.enabled) {
      for (const message of listPendingFeishuConfirmations(db)) {
        const card = getCard(db, message.cardId);
        if (card.status === 'available' && (!result.complete || !card.reportedUsedAt
          || latestCompleteSync(db).checkedAt < card.reportedUsedAt + 600)) continue;
        const state = card.status === 'used' ? 'used'
          : card.status === 'available' ? 'available' : 'unavailable';
        const notice = state === 'used'
          ? 'Codex 已确认该卡从可用列表消失，且可用数量下降；后续到期提醒已停止。'
          : state === 'available' ? '自动核验后，Codex 仍显示这张卡可用；后续提前提醒会保留。'
            : 'Codex 已不再列出这张卡；未观察到对应的可用数量下降。';
        try {
          await patchCard(config, message.messageId, card, message.thresholdDays,
            state, null, notice, null,
            { currentAvailableCount: latestCompleteSync(db)?.availableCount ?? null });
          setFeishuMessageStatus(db, message.messageId, state);
        } catch {
          cardUpdateFailures.push(message.messageId);
        }
      }
    }
    return { ...result, cardUpdateFailures };
  } catch (error) {
    recordSyncFailure(db, error.message);
    throw error;
  } finally {
    db.close();
  }
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  syncCards().then((result) => {
    const change = result.complete && result.countDelta !== null && result.countDelta !== 0
      ? `，较上次${result.countDelta > 0 ? `增加 ${result.countDelta}` : `减少 ${-result.countDelta}`} 张`
      : '';
    console.log(`同步完成：Codex ${result.availableCount} 张可用${change}，保存 ${result.detailedCount} 张到期详情${result.complete ? '' : '（详情不完整，保留旧缓存）'}`);
    if (result.cardUpdateFailures.length) {
      console.warn(`有 ${result.cardUpdateFailures.length} 条飞书状态卡片更新失败，下次同步将重试。`);
    }
    if (!replanScheduledTask()) console.warn('下次精确提醒登记失败；每小时检查仍会补提醒。');
  }).catch((error) => {
    console.error(`同步失败，已保留旧缓存：${error.message}`);
    process.exitCode = 1;
  });
}
