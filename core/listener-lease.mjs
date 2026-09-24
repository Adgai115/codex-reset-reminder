import { createHash } from 'node:crypto';
import { lstat, unlink } from 'node:fs/promises';
import { createConnection, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function listenerAddress(identity) {
  const key = createHash('sha256').update(identity).digest('hex').slice(0, 20);
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\codex-reset-actions-${key}`
    : join(tmpdir(), `codex-reset-actions-${key}.sock`);
}

export async function acquireListenerLease(identity) {
  const address = listenerAddress(identity);
  const listen = async () => {
    const server = createServer((socket) => socket.end());
    try {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(address, resolve);
      });
      server.removeAllListeners('error');
      server.on('error', () => {});
      return server;
    } catch (error) {
      server.close();
      throw error;
    }
  };
  try {
    return await listen();
  } catch (error) {
    if (error.code !== 'EADDRINUSE') throw error;
    if (process.platform === 'win32') return null;
  }
  // Unix socket files survive an unclean exit. Reclaim only an abandoned socket.
  const before = await lstat(address).catch(() => null);
  if (!before?.isSocket()) return null;
  const active = await new Promise((resolve) => {
    const socket = createConnection(address);
    socket.once('connect', () => { socket.end(); resolve(true); });
    socket.once('error', (error) => resolve(error.code !== 'ECONNREFUSED'));
  });
  if (active) return null;
  const after = await lstat(address).catch(() => null);
  if (!after?.isSocket() || before.ino !== after.ino || before.dev !== after.dev) return null;
  await unlink(address).catch((error) => { if (error.code !== 'ENOENT') throw error; });
  try { return await listen(); }
  catch (error) { if (error.code === 'EADDRINUSE') return null; throw error; }
}
