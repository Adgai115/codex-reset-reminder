// Sidecar worker: runs the Node core under the system Node 24 runtime and
// answers JSON-lines requests {id, op, args} with {type:'result', id, ok, ...}.
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline';
import { runCoreOperation } from './core-operations.mjs';

const directory = dirname(fileURLToPath(import.meta.url));
export const projectRoot = join(directory, '..');

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', async (line) => {
  let request;
  try { request = JSON.parse(line); } catch { return; }
  const { id, op, args = {} } = request;
  try {
    const result = await runCoreOperation(op, args);
    process.stdout.write(`${JSON.stringify({ type: 'result', id, ok: true, result })}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ type: 'result', id, ok: false, error: error.message })}\n`);
  }
});
process.stdout.write(`${JSON.stringify({ type: 'ready' })}\n`);
