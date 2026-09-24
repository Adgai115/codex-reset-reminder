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
  const readConfig = async () => JSON.parse(await readFile(configPath, 'utf8'));

  async function consume(config) {
    const command = larkCommand(config);
    const args = ['event', 'consume', 'card.action.trigger', '--profile',
      config.feishu.profile || 'codex-reset-monitor', '--as', 'bot', '--timeout', '1h'];
    child = spawn(command.executable, [...command.prefix, ...args], {
      windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1',
        LARKSUITE_CLI_NO_SKILLS_NOTIFIER: '1' },
    });
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
          if (!['ignored', 'duplicate', 'unauthorized'].includes(outcome)) await onChanged();
        } catch (error) { console.warn(`[feishu] 卡片操作失败：${error.message}`); }
      });
    });
    try {
      await new Promise((resolve, reject) => {
        child.once('close', resolve);
        child.once('error', reject);
      });
      await queue;
    } finally { lines.close(); child = null; }
  }

  async function start() {
    if (loop) return;
    const config = await readConfig();
    if (!config.feishu?.enabled || config.feishu.as !== 'bot' || !config.feishu.userId) return;
    lease = await acquireListenerLease(databasePath);
    if (!lease) { console.log('[feishu] 旧版监听已占用，Electron 跳过监听'); return; }
    stopped = false;
    loop = (async () => {
      while (!stopped) {
        try {
          const current = await readConfig();
          if (!current.feishu?.enabled) break;
          await consume(current);
        } catch (error) { console.warn(`[feishu] 监听重试：${error.message}`); }
        if (!stopped) await wait(5000);
      }
      lease?.close();
      lease = null;
      loop = null;
    })();
  }
  function stop() {
    stopped = true;
    child?.kill();
  }
  return { start, stop };
}
