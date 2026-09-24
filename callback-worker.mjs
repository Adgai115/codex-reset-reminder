import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline';
import { handleCardAction } from './card-actions.mjs';
import { larkCommand } from './native-bin.mjs';
import { acquireListenerLease } from './listener-lease.mjs';
import { replanScheduledTask } from './replan.mjs';
import { dataDirectory, databasePath } from './store.mjs';

const directory = dirname(fileURLToPath(import.meta.url));
const readConfig = () => JSON.parse(readFileSync(join(directory, 'config.json'), 'utf8'));
let config = readConfig();
const logPath = join(dataDirectory, 'callback.log');
mkdirSync(dataDirectory, { recursive: true });
function log(message) {
  appendFileSync(logPath, `${new Date().toISOString()} ${message}\n`, 'utf8');
}
const wait = (ms) => new Promise((done) => setTimeout(done, ms));
let stopping = false;
let child = null;
let activeProfile = null;
process.on('SIGTERM', () => { stopping = true; child?.kill(); });
process.on('SIGINT', () => { stopping = true; child?.kill(); });

async function consumeSession() {
  const args = ['event', 'consume', 'card.action.trigger',
    '--profile', config.feishu.profile || 'codex-reset-monitor', '--as', 'bot', '--timeout', '1h'];
  const command = larkCommand(config);
  activeProfile = config.feishu.profile || 'codex-reset-monitor';
  child = spawn(command.executable, [...command.prefix, ...args], { windowsHide: true,
    env: { ...process.env, LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1', LARKSUITE_CLI_NO_SKILLS_NOTIFIER: '1' } });
  const lines = readline.createInterface({ input: child.stdout });
  let ready = false;
  let queue = Promise.resolve();
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr = (stderr + chunk.toString()).slice(-8192);
    if (!ready && stderr.includes('[event] ready event_key=card.action.trigger')) {
      ready = true;
      log('listener ready');
    }
  });
  lines.on('line', (line) => {
    queue = queue.then(async () => {
      let event;
      try { event = JSON.parse(line); } catch { log('ignored malformed event'); return; }
      try {
        config = readConfig();
        if (!config.feishu?.enabled) {
          log('飞书渠道已关闭，忽略卡片操作');
          stopping = true;
          child?.kill();
          return;
        }
        const outcome = await handleCardAction(event, config);
        log(`event ${event.event_id || 'unknown'}: ${outcome}`);
        if (!['ignored', 'duplicate', 'unauthorized'].includes(outcome) && !replanScheduledTask()) {
          log('重新登记下次提醒失败；每小时兜底仍会检查');
        }
      } catch (error) { log(`event ${event.event_id || 'unknown'} failed: ${error.message}`); }
    });
  });
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  await queue;
  lines.close();
  child = null;
  activeProfile = null;
  if (!ready) {
    let reason = 'listener ended before ready';
    try { reason = JSON.parse(stderr).error?.message || reason; } catch { /* Keep logs free of raw token data. */ }
    if (reason === 'listener ended before ready' && stderr.trim()) {
      reason = `${reason}: ${stderr.trim().replace(/\s+/g, ' ').slice(-500)}`;
    }
    log(reason);
  } else { log(`listener exited code=${code}`); }
}

const lease = config.feishu?.enabled && config.feishu.as === 'bot' && config.feishu.userId
  ? await acquireListenerLease(databasePath) : null;
if (lease) {
  const settingsWatch = setInterval(() => {
    try {
      config = readConfig();
      if (!config.feishu?.enabled) {
        stopping = true;
        child?.kill();
      } else if (child && (config.feishu.profile || 'codex-reset-monitor') !== activeProfile) {
        log('listener profile changed; reconnecting');
        child?.kill();
      }
    } catch (error) { log(`无法读取飞书渠道设置：${error.message}`); }
  }, 30000);
  settingsWatch.unref();
  try {
    log(`callback worker started pid=${process.pid} db=${databasePath}`);
    while (!stopping) {
      config = readConfig();
      if (!config.feishu?.enabled) break;
      try { await consumeSession(); }
      catch (error) {
        child?.kill();
        child = null;
        log(`listener error: ${error.message}`);
      }
      if (!stopping) await wait(5000);
    }
    log('callback worker stopped');
  } finally {
    clearInterval(settingsWatch);
    child?.kill();
    lease.close();
  }
}
