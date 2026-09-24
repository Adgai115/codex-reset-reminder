import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { acquireListenerLease, listenerAddress } from './listener-lease.mjs';

test('Unix listener recovers its lease after the previous process crashes',
  { skip: process.platform === 'win32' }, async () => {
    const identity = randomUUID();
    const address = listenerAddress(identity);
    const child = spawn(process.execPath, ['-e', `
      require('node:net').createServer((socket) => socket.end())
        .listen(${JSON.stringify(address)}, () => process.stdout.write('ready\\n'));
    `], { stdio: ['ignore', 'pipe', 'pipe'] });
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('监听进程启动超时')), 5000);
        child.stdout.once('data', () => { clearTimeout(timer); resolve(); });
        child.once('error', (error) => { clearTimeout(timer); reject(error); });
        child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`监听进程提前退出：${code}`)); });
      });
      const exited = new Promise((resolve) => child.once('exit', resolve));
      child.kill('SIGKILL');
      await exited;
      assert.ok(existsSync(address));
      const lease = await acquireListenerLease(identity);
      assert.ok(lease);
      await new Promise((resolve) => lease.close(resolve));
    } finally {
      if (child.exitCode === null) child.kill('SIGKILL');
      await unlink(address).catch((error) => { if (error.code !== 'ENOENT') throw error; });
    }
  });
