import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import readline from 'node:readline';
import { acquireListenerLease } from '../core/listener-lease.mjs';
import { larkCommand } from '../core/native-bin.mjs';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function createCallbackListener({ configPath, databasePath, coreRequest, onChanged }) {
  let stopped = false;
  let child = null;
  let lease = null;
  let loop = null;
  let health = { state: 'starting', lastError: null, lastEventAt: null };
  const readConfig = async () => JSON.parse(await readFile(configPath, 'utf8'));
  const setHealth = (state, error = null) => {
    health = { ...health, state, lastError: error ? String(error).slice(0, 180) : null };
  };

  async function consume(config) {
    const command = larkCommand(config);
    const args = ['event', 'consume', 'card.action.trigger', '--profile',
      config.feishu.profile || 'codex-reset-monitor', '--as', 'bot', '--timeout', '1h'];
    child = spawn(command.executable, [...command.prefix, ...args], {
      windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1',
        LARKSUITE_CLI_NO_SKILLS_NOTIFIER: '1' },
    });
    child.once('spawn', () => setHealth('listening'));
    child.stderr.resume();
    const lines = readline.createInterface({ input: child.stdout });
    let queue = Promise.resolve();
    lines.on('line', (line) => {
      queue = queue.then(async () => {
        let event;
        try { event = JSON.parse(line); } catch { return; }
        try {
          const current = await readConfig();
          if (!current.feishu?.enabled) return;
          const outcome = await coreRequest('handleCardAction', { event, config: current });
          health = { ...health, lastEventAt: Date.now() };
          if (!['ignored', 'duplicate', 'unauthorized'].includes(outcome)) await onChanged();
        } catch (error) { console.warn(`[feishu] 卡片操作失败：${error.message}`); }
      });
    });
    try {
      const code = await new Promise((resolve, reject) => {
        child.once('close', resolve);
        child.once('error', reject);
      });
      await queue;
      if (!stopped && code !== 0) throw new Error(`飞书 CLI 监听退出，代码 ${code}`);
      if (!stopped) setHealth('starting');
    } finally { lines.close(); child = null; }
  }

  async function start() {
    if (loop) {
      if (!stopped) return;
      await loop;
    }
    const config = await readConfig();
    if (!config.feishu?.enabled) { setHealth('disabled'); return; }
    if (config.feishu.as !== 'bot' || !config.feishu.userId) { setHealth('unconfigured'); return; }
    setHealth('starting');
    lease = await acquireListenerLease(databasePath);
    if (!lease) { setHealth('occupied'); console.log('[feishu] 已有监听占用，Electron 跳过监听'); return; }
    stopped = false;
    loop = (async () => {
      while (!stopped) {
        try {
          const current = await readConfig();
          if (!current.feishu?.enabled) break;
          await consume(current);
        } catch (error) {
          setHealth('retrying', error.message);
          console.warn(`[feishu] 监听重试：${error.message}`);
        }
        if (!stopped) await wait(5000);
      }
      lease?.close();
      lease = null;
      loop = null;
      if (stopped) setHealth('disabled');
    })();
  }
  function stop() {
    stopped = true;
    setHealth('disabled');
    child?.kill();
    return loop || Promise.resolve();
  }
  async function refresh() {
    stop();
    if (loop) await loop;
    return start();
  }
  return { start, stop, refresh, status: () => ({ ...health }) };
}
