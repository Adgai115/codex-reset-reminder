import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendFileSync, readFileSync } from 'node:fs';
import { getSnoozeOptions, planSnooze } from './later.mjs';
import { planCardNextCheck } from './plan-next.mjs';
import { enabledChannels, quietHours } from './reminder-policy.mjs';
import { replanScheduledTask } from './replan.mjs';
import { addManualCard, clearSnooze, getCard, getSnooze, latestCompleteSync, latestSync, listCards,
  markCardUsed, openStore, reportCardUsed, scheduleSnooze, updateManualCard, dataDirectory } from './store.mjs';

export function parseLocalExpiry(input) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(input || '')) {
    throw new Error('到期时间格式：YYYY-MM-DDTHH:mm（本地时间）');
  }
  const date = new Date(`${input}:00`);
  if (Number.isNaN(date.getTime()) || date.getFullYear() !== Number(input.slice(0, 4))
    || date.getMonth() + 1 !== Number(input.slice(5, 7)) || date.getDate() !== Number(input.slice(8, 10))
    || date.getHours() !== Number(input.slice(11, 13)) || date.getMinutes() !== Number(input.slice(14, 16))) {
    throw new Error('无效的本地日期或时间');
  }
  return Math.floor(date.getTime() / 1000);
}

export function runCardsCommand([command, ...args]) {
  const db = openStore();
  try {
    switch (command) {
      case 'list': {
        const config = JSON.parse(readFileSync(new URL('./config.json', import.meta.url), 'utf8'));
        const channels = enabledChannels(config);
        const quiet = quietHours(config);
        const nowSeconds = Math.floor(Date.now() / 1000);
        const complete = latestCompleteSync(db);
        const cards = listCards(db, true).map((card) => {
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
      case 'add': return { id: addManualCard(db, { title: args[0], expiresAt: parseLocalExpiry(args[1]) }) };
      case 'edit': return { updated: updateManualCard(db, args[0], { title: args[1], expiresAt: parseLocalExpiry(args[2]) }) };
      case 'used': {
        const card = getCard(db, args[0]);
        if (!card || card.source !== 'manual') throw new Error('只有手动卡片可以直接标记已使用');
        return { updated: markCardUsed(db, card.id) };
      }
      case 'report-used': return { card: reportCardUsed(db, args[0]) };
      case 'options': return { options: getSnoozeOptions(getCard(db, args[0])) };
      case 'later': {
        const card = getCard(db, args[0]);
        const plan = planSnooze(card, args[1]);
        scheduleSnooze(db, card.id, card.expiresAt, plan.targetAt);
        return plan;
      }
      case 'unsnooze': {
        const card = getCard(db, args[0]);
        const snooze = card && getSnooze(db, card.id);
        if (!card || card.status !== 'available' || snooze?.expiresAt !== card.expiresAt) {
          throw new Error('这张卡片没有可取消的延期提醒');
        }
        clearSnooze(db, card.id);
        return { cleared: true };
      }
      default: throw new Error('用法：cards.mjs list | add <名称> <YYYY-MM-DDTHH:mm> | edit <编号> <名称> <时间> | used <手动卡编号> | report-used <Codex卡编号> | options <编号> | later <编号> <1d|3d|tomorrow10> | unsnooze <编号>');
    }
  } finally { db.close(); }
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  try {
    const command = process.argv[2];
    console.log(JSON.stringify(runCardsCommand(process.argv.slice(2)), null, 2));
    if (['add', 'edit', 'used', 'report-used', 'later', 'unsnooze'].includes(command) && !replanScheduledTask()) {
      appendFileSync(`${dataDirectory}/reminder-events.log`, `${new Date().toISOString()} 重新登记下次提醒失败；每小时兜底仍会检查。\n`);
    }
  }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
