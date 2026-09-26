// 在隔离的临时数据目录中启动已打包应用，检查真实渲染进程和 preload。
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function executable() {
  if (process.platform === 'win32') return join(dist, 'win-unpacked', 'Codex Reset Reminder.exe');
  if (process.platform === 'linux') return join(dist, 'linux-unpacked', 'codex-reset-reminder');
  for (const entry of await readdir(dist, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith('mac')) continue;
    const apps = await readdir(join(dist, entry.name));
    const bundle = apps.find((name) => name.endsWith('.app'));
    if (bundle) return join(dist, entry.name, bundle, 'Contents', 'MacOS', 'Codex Reset Reminder');
  }
  throw new Error('没有找到 macOS 目录包');
}

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function page(port, suffix, child, deadline) {
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`应用提前退出：${child.exitCode}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json`, { signal: AbortSignal.timeout(1500) });
      const tabs = await response.json();
      const found = tabs.find((tab) => tab.type === 'page' && tab.url?.endsWith(suffix));
      if (found?.webSocketDebuggerUrl) return found;
    } catch { /* 调试端口仍在启动。 */ }
    await sleep(300);
  }
  throw new Error(`等待窗口超时：${suffix}`);
}

async function evaluate(tab, expression) {
  const socket = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  try {
    const id = 1;
    const result = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('渲染进程没有响应')), 5000);
      socket.addEventListener('message', (event) => {
        const message = JSON.parse(event.data);
        if (message.id !== id) return;
        clearTimeout(timer);
        if (message.error || message.result?.exceptionDetails) reject(new Error(JSON.stringify(message.error || message.result.exceptionDetails)));
        else resolve(message.result.result.value);
      });
    });
    socket.send(JSON.stringify({ id, method: 'Runtime.evaluate',
      params: { expression, awaitPromise: true, returnByValue: true } }));
    return await result;
  } finally { socket.close(); }
}

async function stopTree(child) {
  if (!child || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    await new Promise((resolve) => spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'],
      { windowsHide: true, stdio: 'ignore' }).once('close', resolve));
  } else {
    try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill(); }
  }
  await Promise.race([new Promise((resolve) => child.once('close', resolve)), sleep(5000)]);
}

const profile = await mkdtemp(join(tmpdir(), 'codex-reset-ui-smoke-'));
let child;
let logs = '';
try {
  const appPath = await executable();
  assert.ok(existsSync(appPath), `安装包程序不存在：${appPath}`);
  // 用假卡和不存在的 Codex 命令，保证测试不会消耗真实卡或发送消息。
  process.env.CODEX_RESET_MONITOR_DATA_DIR = profile;
  const { openStore, addManualCard } = await import('../core/store.mjs');
  const db = openStore();
  try { addManualCard(db, { title: 'CI 演示重置卡', expiresAt: Math.floor(Date.now() / 1000) + 10 * 86400 }); }
  finally { db.close(); }
  const config = JSON.parse(await readFile(join(root, 'config.example.json'), 'utf8'));
  config.codexScript = join(profile, 'codex-does-not-exist');
  config.desktop.enabled = false;
  config.feishu.enabled = false;
  await writeFile(join(profile, 'config.json'), JSON.stringify(config));
  const port = await freePort();
  child = spawn(appPath, [`--remote-debugging-port=${port}`, '--enable-logging'], {
    detached: process.platform !== 'win32',
    env: { ...process.env, CODEX_RESET_MONITOR_USER_DATA_DIR: profile,
      CODEX_RESET_MONITOR_SKIP_MIGRATION: '1', CODEX_RESET_MONITOR_DATA_DIR: profile },
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  child.stdout.on('data', (chunk) => { logs = (logs + chunk.toString()).slice(-10000); });
  child.stderr.on('data', (chunk) => { logs = (logs + chunk.toString()).slice(-10000); });
  const deadline = Date.now() + 45000;
  let cards;
  do {
    const tab = await page(port, '/ui/manage/index.html', child, deadline);
    cards = await evaluate(tab, `({bridge: Boolean(window.api), rows: Array.from(document.querySelectorAll('#cards tbody tr'), row => row.textContent), status: document.querySelector('#sync-status')?.textContent})`);
    if (cards.bridge && cards.rows.some((row) => row.includes('CI 演示重置卡'))) break;
    await sleep(300);
  } while (Date.now() < deadline);
  assert.ok(cards.bridge, 'preload 没有加载');
  assert.ok(cards.rows.some((row) => row.includes('CI 演示重置卡')), `卡片没有显示：${JSON.stringify(cards)}`);
  assert.ok(!cards.status?.includes('读取失败'), `卡片读取失败：${cards.status}`);
  const manage = await page(port, '/ui/manage/index.html', child, deadline);
  await evaluate(manage, 'window.api.openSettings().then(() => true)');
  let settings;
  do {
    const tab = await page(port, '/ui/settings/index.html', child, deadline);
    settings = await evaluate(tab, `({bridge: Boolean(window.api), listener: document.querySelector('#listener-state')?.textContent, connection: document.querySelector('#feishu-state')?.textContent})`);
    if (settings.listener?.includes('尚未配置机器人') && settings.connection?.includes('尚未连接')) break;
    await sleep(300);
  } while (Date.now() < deadline);
  assert.ok(settings.bridge, '设置窗口 preload 没有加载');
  assert.match(settings.listener, /尚未配置机器人/);
  assert.match(settings.connection, /尚未连接/);
  console.log(`安装包界面检查通过：${process.platform}，卡片管理和设置窗口`);
} catch (error) {
  console.error(error);
  if (logs) console.error(logs);
  process.exitCode = 1;
} finally {
  await stopTree(child);
  await rm(profile, { recursive: true, force: true });
}
