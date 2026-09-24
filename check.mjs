import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { access, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline';
import { codexCommand } from './native-bin.mjs';

const directory = dirname(fileURLToPath(import.meta.url));
const thresholds = [1, 3, 7];
const dryRun = process.argv.includes('--dry-run');
const testNotification = process.argv.includes('--test-notification');

function send(processHandle, message) {
  processHandle.stdin.write(`${JSON.stringify(message)}\n`);
}

export async function callAppServer(codexScript, method, params) {
  return new Promise((resolveResponse, rejectResponse) => {
    const command = codexCommand(codexScript);
    const processHandle = spawn(command.executable, [...command.prefix, 'app-server', '--stdio'], {
      cwd: directory,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      ...(command.env ? { env: command.env } : {}),
    });
    const lines = readline.createInterface({ input: processHandle.stdout });
    let finished = false;
    const timeout = setTimeout(() => finish(new Error('Codex App Server 读取超时')), 45000);

    function finish(error, result) {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      lines.close();
      processHandle.kill();
      if (error) rejectResponse(error);
      else resolveResponse(result);
    }

    processHandle.on('error', () => finish(new Error('无法启动 Codex App Server')));
    processHandle.on('exit', (code) => {
      if (!finished) finish(new Error(`Codex App Server 提前退出，代码 ${code}`));
    });
    processHandle.stderr.resume();
    lines.on('line', (line) => {
      let response;
      try { response = JSON.parse(line); } catch { return; }
      if (response.id === 1) {
        if (response.error) return finish(new Error('Codex App Server 初始化失败'));
        send(processHandle, { method: 'initialized', params: {} });
        send(processHandle, { method, id: 2, ...(params ? { params } : {}) });
      } else if (response.id === 2) {
        if (response.error) return finish(new Error(`Codex 请求失败：${response.error.code ?? 'unknown'}`));
        finish(null, response.result);
      }
    });
    send(processHandle, {
      method: 'initialize', id: 1,
      params: { clientInfo: { name: 'codex_reset_card_reminder', title: 'Codex Reset Card Reminder', version: '1.0.0' } },
    });
  });
}

export function dueThreshold(expiresAt, nowSeconds) {
  if (!Number.isFinite(expiresAt) || expiresAt <= nowSeconds) return null;
  const secondsRemaining = expiresAt - nowSeconds;
  return thresholds.find((days) => secondsRemaining <= days * 86400) ?? null;
}

export function planReminders(credits, sent, nowSeconds) {
  const groups = new Map();
  for (const credit of credits) {
    if (credit?.status !== 'available' || !Number.isFinite(credit.expiresAt) || !credit.id) continue;
    const days = dueThreshold(credit.expiresAt, nowSeconds);
    if (days === null) continue;
    const key = createHash('sha256').update(`${credit.id}:${credit.expiresAt}`).digest('hex');
    if (sent[key]?.includes(days)) continue;
    if (!groups.has(days)) groups.set(days, []);
    groups.get(days).push({ key, id: credit.id, title: credit.title || '重置卡', expiresAt: credit.expiresAt });
  }
  return [...groups].sort(([a], [b]) => a - b);
}

export async function showNotification({ cardName, creditId, source = 'codex', expiresLocal, days,
  currentAvailableCount = null, syncedAt = null, simulated = false, autoCloseSeconds = 0, stackIndex = 0 }) {
  const powershell = process.env.CODEX_REMINDER_PWSH || 'pwsh.exe';
  const readyPath = join(tmpdir(), `codex-reset-reminder-${randomUUID()}.ready`);
  const child = spawn(powershell, [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden',
    '-File', join(directory, 'notify.ps1'), '-CardName', cardName,
    '-CreditId', creditId, '-ExpiresLocal', expiresLocal, '-Days', String(days),
    '-ReadyPath', readyPath, '-AutoCloseSeconds', String(autoCloseSeconds), '-StackIndex', String(stackIndex),
    ...(Number.isInteger(currentAvailableCount) ? ['-CurrentAvailableCount', String(currentAvailableCount)] : []),
    ...(Number.isInteger(syncedAt) ? ['-SyncedAt', String(syncedAt)] : []),
    ...(simulated ? ['-Simulation'] : []), ...(source === 'manual' ? ['-Manual'] : []),
  ], { stdio: 'ignore', windowsHide: true });
  let launchError = null;
  child.on('error', (error) => { launchError = error; });
  for (let attempt = 0; attempt < 50; attempt++) {
    if (launchError) throw new Error('无法启动 Windows 提醒窗口');
    try {
      await access(readyPath);
      await unlink(readyPath);
      child.unref();
      return;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (child.exitCode !== null) throw new Error(`Windows 提醒窗口提前退出，代码 ${child.exitCode}`);
    await new Promise((done) => setTimeout(done, 200));
  }
  child.kill();
  throw new Error('Windows 提醒窗口未能显示');
}

async function main() {
  if (testNotification) {
    const expiry = new Date(Date.now() + 2 * 86400000).toLocaleString('zh-CN', { hour12: false });
    await showNotification({
      cardName: '演示重置卡', creditId: 'DEMO-CARD-001', expiresLocal: expiry,
      days: 2, simulated: true, autoCloseSeconds: 90,
    });
    return;
  }

  const { runReminders } = await import('./remind.mjs');
  if (!dryRun) {
    const { syncCards } = await import('./sync.mjs');
    try { await syncCards(); }
    catch (error) { console.warn(`Codex 同步失败，继续从本地缓存提醒：${error.message}`); }
  }
  console.log(JSON.stringify(await runReminders({ dryRun }), null, 2));
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
