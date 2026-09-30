// 独立的 stdio 会话：只调用账号接口，不创建对话或使用模型。
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { codexCommand } from '../core/native-bin.mjs';

export function createCodexSession(script, { home = null, onNotification = () => {},
  onExit = () => {}, timeoutMs = 45_000, managed = true } = {}) {
  const command = codexCommand(script);
  const args = [...command.prefix, 'app-server', '--stdio'];
  if (home && managed) args.push('-c', 'cli_auth_credentials_store="file"');
  const child = spawn(command.executable, args, { windowsHide: true,
    ...(home ? { cwd: home } : {}), stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ...command.env, ...(home ? { CODEX_HOME: home } : {}) } });
  child.stderr.resume();
  const lines = readline.createInterface({ input: child.stdout });
  const pending = new Map();
  let nextId = 1;
  let closed = false;
  let exited = false;
  const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
  const fail = () => {
    exited = true;
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error('Codex 连接已中断')); }
    pending.clear(); lines.close(); onExit();
  };
  child.on('error', fail);
  const exitPromise = new Promise((resolve) => child.once('exit', () => { fail(); resolve(); }));
  function requestRaw(method, params) {
    if (closed || exited) return Promise.reject(new Error('Codex 会话已关闭'));
    return new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('Codex 账号请求超时')); }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      send({ id, method, ...(params ? { params } : {}) });
    });
  }
  lines.on('line', (line) => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (pending.has(message.id)) {
      const entry = pending.get(message.id); pending.delete(message.id); clearTimeout(entry.timer);
      if (message.error) entry.reject(new Error(`Codex 请求失败（${message.error.code ?? 'unknown'}）`));
      else entry.resolve(message.result);
    } else if (message.method && message.id !== undefined) {
      send({ id: message.id, error: { code: -32601, message: 'Unsupported client request' } });
    } else if (message.method) onNotification(message.method, message.params);
  });
  const ready = requestRaw('initialize', { clientInfo: { name: 'codex_reset_card_reminder',
    title: 'Codex Reset Card Reminder', version: '2.2.0' } }).then(() => send({ method: 'initialized', params: {} }));
  ready.catch(() => {});
  return { request: async (method, params) => { await ready; return requestRaw(method, params); },
    async close() {
      if (closed) return;
      closed = true; child.stdin.end(); child.kill();
      await Promise.race([exitPromise, new Promise((resolve) => { const timer = setTimeout(resolve, 2000); timer.unref?.(); })]);
      lines.close();
    } };
}
