// Sidecar worker: runs the Node core under the system Node 24 runtime and
// answers JSON-lines requests {id, op, args} with {type:'result', id, ok, ...}.
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline';
import { runCoreOperation } from './core-operations.mjs';
import { restoreCoreError } from './error-protocol.mjs';

const directory = dirname(fileURLToPath(import.meta.url));
export const projectRoot = join(directory, '..');
let nextEventId = 1;
const pendingDesktop = new Map();
const pendingAccounts = new Map();

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', async (line) => {
  let request;
  try { request = JSON.parse(line); } catch { return; }
  if (request.type === 'account-result') {
    const pending = pendingAccounts.get(request.eventId);
    if (pending) { pendingAccounts.delete(request.eventId);
      if (request.ok) pending.resolve(request.result); else pending.reject(restoreCoreError(request)); }
    return;
  }
  if (request.type === 'desktop-result') {
    const pending = pendingDesktop.get(request.eventId);
    if (pending) {
      pendingDesktop.delete(request.eventId);
      if (request.ok) pending.resolve();
      else pending.reject(new Error(request.error));
    }
    return;
  }
  const { id, op, args = {} } = request;
  try {
    const result = await runCoreOperation(op, args, {
      accounts: (action, args) => new Promise((resolve, reject) => {
        const eventId = nextEventId++;
        pendingAccounts.set(eventId, { resolve, reject });
        process.stdout.write(`${JSON.stringify({ type: 'account', eventId, action, args })}\n`);
      }), desktop: (payload) => new Promise((resolve, reject) => {
      const eventId = nextEventId++;
      pendingDesktop.set(eventId, { resolve, reject });
      process.stdout.write(`${JSON.stringify({ type: 'desktop', eventId, payload })}\n`);
    }) });
    process.stdout.write(`${JSON.stringify({ type: 'result', id, ok: true, result })}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ type: 'result', id, ok: false, error: error.message,
      afterRequest: error.afterRequest === true,
      ...(/^ACCOUNT_[A-Z_]{1,48}$/.test(error.code || '') ? { code: error.code } : {}) })}\n`);
  }
});
process.stdout.write(`${JSON.stringify({ type: 'ready' })}\n`);
