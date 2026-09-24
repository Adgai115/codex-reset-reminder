import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function listenerAddress(identity) {
  const key = createHash('sha256').update(identity).digest('hex').slice(0, 20);
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\codex-reset-actions-${key}`
    : join(tmpdir(), `codex-reset-actions-${key}.sock`);
}

export async function acquireListenerLease(identity) {
  const server = createServer((socket) => socket.end());
  const address = listenerAddress(identity);
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
    if (error.code === 'EADDRINUSE') return null;
    throw error;
  }
}
