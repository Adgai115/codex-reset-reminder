import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listDueUsageVerifications, openStore } from './store.mjs';
import { syncCards } from './sync.mjs';

export async function verifyPendingUsage({ nowSeconds = Math.floor(Date.now() / 1000), sync = syncCards } = {}) {
  const db = openStore();
  let due;
  try { due = listDueUsageVerifications(db, nowSeconds); }
  finally { db.close(); }
  if (!due.length) return { checked: false, cardIds: [] };
  const result = await sync();
  return { checked: true, cardIds: due.map((card) => card.id), result };
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  verifyPendingUsage().then((result) => {
    if (!process.argv.includes('--quiet') || result.checked) {
      console.log(result.checked
        ? `已延迟核验 ${result.cardIds.length} 张卡：${result.result.complete ? 'Codex 返回完整详情' : '详情不完整，保留待核实状态'}`
        : '没有到期的使用反馈需要核验');
    }
  }).catch((error) => { console.error(`延迟核验失败：${error.message}`); process.exitCode = 1; });
}
