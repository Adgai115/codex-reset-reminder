// Sidecar worker: runs the Node core under the system Node 24 runtime and
// answers JSON-lines requests {id, op, args} with {type:'result', id, ok, ...}.
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline';
import * as store from '../core/store.mjs';

const directory = dirname(fileURLToPath(import.meta.url));
export const projectRoot = join(directory, '..');

const readers = {
  listCards: (db) => store.listCards(db),
  latestSync: (db) => store.latestSync(db),
  latestCompleteSync: (db) => store.latestCompleteSync(db),
};

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', async (line) => {
  let request;
  try { request = JSON.parse(line); } catch { return; }
  const { id, op, args = {} } = request;
  try {
    const db = store.openStore();
    try {
      let result;
      if (readers[op]) result = readers[op](db);
      else if (op === 'snooze') result = store.getSnooze(db, args.cardId);
      else throw new Error(`未知操作：${op}`);
      process.stdout.write(`${JSON.stringify({ type: 'result', id, ok: true, result })}\n`);
    } finally { db.close(); }
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ type: 'result', id, ok: false, error: error.message })}\n`);
  }
});
process.stdout.write(`${JSON.stringify({ type: 'ready' })}\n`);
