// 隔离安装包测试用 App Server。只从同目录的 JSON fixture 读取数据。
import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

createInterface({ input: process.stdin }).on('line', (line) => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  appendFileSync(join(import.meta.dirname, 'mock-requests.log'), `${request.method}\n`);
  let response;
  try {
    let root = import.meta.dirname;
    if (process.env.CODEX_HOME) {
      try { root = JSON.parse(readFileSync(join(process.env.CODEX_HOME, 'auth.json'), 'utf8')).mockProfile || root; }
      catch { /* 旧演示 fixture 不需要登录文件。 */ }
    }
    const file = { 'account/read': 'mock-account.json',
      'account/rateLimits/read': 'mock-usage.json' }[request.method];
    if (request.method !== 'initialize' && !file) throw new Error('unsupported');
    response = { id: request.id, result: file
      ? JSON.parse(readFileSync(join(root, file), 'utf8')) : {} };
  } catch {
    response = { id: request.id, error: { code: -32000, message: 'Mock response unavailable' } };
  }
  process.stdout.write(`${JSON.stringify(response)}\n`);
});
