import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendFileSync, readFileSync } from 'node:fs';
import { getSnoozeOptions, planSnooze } from './later.mjs';
import { planCardNextCheck } from './plan-next.mjs';
import { enabledChannels, quietHours } from './reminder-policy.mjs';
import { replanScheduledTask } from './replan.mjs';
import { clearSnooze, getCard, getSnooze, latestCompleteSync, latestSync, listCards,
  openStore, reportCardUsed, scheduleSnooze, dataDirectory } from './store.mjs';

export function runCardsCommand([command, ...args]) {
  const db = openStore();
  try {
    switch (command) {
      case 'list': {
        const config = JSON.parse(readFileSync(process.env.CODEX_RESET_MONITOR_CONFIG_PATH
          || new URL('../../config.json', import.meta.url), 'utf8'));
        const channels = enabledChannels(config);
        const quiet = quietHours(config);
        const nowSeconds = Math.floor(Date.now() / 1000);
        const complete = latestCompleteSync(db);
        const cards = listCards(db, true).filter((card) => card.source === 'codex').map((card) => {
          const snooze = getSnooze(db, card.id);
          const plan = planCardNextCheck(db, card,
            { channels, quiet, nowSeconds, completeSyncAt: complete?.checkedAt ?? 0 });
          return { ...card,
            snoozeTargetAt: snooze?.expiresAt === card.expiresAt ? snooze.targetAt : null,
            nextReminderAt: plan.nextAt, nextReminderKind: plan.nextKind,
            dueReminderAt: plan.dueAt, dueReminderKind: plan.dueKind };
        });
        return { cards, channels, latestSync: latestSync(db), latestCompleteSync: complete };
      }
      case 'add':
      case 'edit':
      case 'used': throw new Error('重置卡由 Codex 官方发放；本地新增、编辑和标记手动卡功能已移除。');
      case 'report-used': return { card: reportCardUsed(db, args[0]) };
      case 'options': {
        const card = getCard(db, args[0]);
        return { options: card?.source === 'codex' ? getSnoozeOptions(card) : [] };
      }
      case 'later': {
        const card = getCard(db, args[0]);
        if (card?.source !== 'codex') throw new Error('只支持从 Codex 同步的官方重置卡');
        const plan = planSnooze(card, args[1]);
        scheduleSnooze(db, card.id, card.expiresAt, plan.targetAt);
        return plan;
      }
      case 'unsnooze': {
        const card = getCard(db, args[0]);
        const snooze = card && getSnooze(db, card.id);
        if (card?.source !== 'codex' || card.status !== 'available' || snooze?.expiresAt !== card.expiresAt) {
          throw new Error('这张卡片没有可取消的延期提醒');
        }
        clearSnooze(db, card.id);
        return { cleared: true };
      }
      default: throw new Error('用法：cards.mjs list | report-used <Codex卡编号> | options <编号> | later <编号> <1d|3d|tomorrow10> | unsnooze <编号>');
    }
  } finally { db.close(); }
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  try {
    const command = process.argv[2];
    console.log(JSON.stringify(runCardsCommand(process.argv.slice(2)), null, 2));
    if (['report-used', 'later', 'unsnooze'].includes(command) && !replanScheduledTask()) {
      appendFileSync(`${dataDirectory}/reminder-events.log`, `${new Date().toISOString()} 重新登记下次提醒失败；每小时兜底仍会检查。\n`);
    }
  }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
