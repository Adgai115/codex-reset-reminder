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
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('无法连接渲染进程调试端口')), 5000);
      socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      socket.addEventListener('error', (error) => { clearTimeout(timer); reject(error); }, { once: true });
    });
    const id = 1;
    const result = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('渲染进程没有响应')), 15000);
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
  if (!child) return;
  if (process.platform === 'win32') {
    await new Promise((resolve) => spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'],
      { windowsHide: true, stdio: 'ignore' }).once('close', resolve));
  } else {
    try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill(); }
  }
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 3000);
    child.once('close', () => { clearTimeout(timer); resolve(); });
  });
  if (process.platform !== 'win32') {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { /* 进程组已退出。 */ }
  }
  child.stdout?.destroy();
  child.stderr?.destroy();
  child.unref();
}

const profile = await mkdtemp(join(tmpdir(), 'codex-reset-ui-smoke-'));
const setupOnly = process.argv.includes('--setup');
let child;
let logs = '';
try {
  const appPath = await executable();
  assert.ok(existsSync(appPath), `安装包程序不存在：${appPath}`);
  // 用隔离的假卡和不存在的 Codex 命令，保证测试不会消耗真实卡或发送消息。
  if (!setupOnly) {
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
  }
  const port = await freePort();
  // CI 的 Linux 解包目录不能把 chrome-sandbox 设为 root:4755；仅测试进程关闭沙盒。
  const testFlags = process.platform === 'linux' ? ['--no-sandbox'] : [];
  child = spawn(appPath, [`--remote-debugging-port=${port}`, '--enable-logging', ...testFlags], {
    detached: process.platform !== 'win32',
    env: { ...process.env, CODEX_RESET_MONITOR_USER_DATA_DIR: profile,
      CODEX_RESET_MONITOR_SKIP_MIGRATION: '1', CODEX_RESET_MONITOR_DATA_DIR: profile },
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  child.stdout.on('data', (chunk) => { logs = (logs + chunk.toString()).slice(-10000); });
  child.stderr.on('data', (chunk) => { logs = (logs + chunk.toString()).slice(-10000); });
  console.log(`已启动 ${process.platform} 安装包，等待${setupOnly ? '安装与连接' : '卡片管理'}窗口`);
  const deadline = Date.now() + 45000;
  if (setupOnly) {
    const setup = await page(port, '/ui/setup/index.html', child, deadline);
    let setupState;
    do {
      setupState = await evaluate(setup, `({bridge: Boolean(window.api), title: document.title})`);
      if (setupState.bridge && setupState.title?.includes('安装与连接')) break;
      await sleep(200);
    } while (Date.now() < deadline);
    assert.ok(setupState.bridge, '首次安装窗口 preload 没有加载');
    assert.match(setupState.title, /安装与连接/);
    console.log('首次安装窗口已加载，检查 Codex 诊断按钮');
    const probe = await evaluate(setup,
      `window.api.setupProbeCodex(${JSON.stringify(join(profile, 'missing-codex'))})`);
    assert.equal(probe.ok, false);
    await evaluate(setup, `document.querySelector('#path').value = ${JSON.stringify(join(profile, 'missing-codex'))};
      document.querySelector('#probe').click(); true`);
    let probeText = '';
    while (Date.now() < deadline && !probeText.includes('未找到 Codex CLI')) {
      probeText = await evaluate(setup, `document.querySelector('#probe-status')?.textContent`);
      await sleep(100);
    }
    assert.match(probeText, /未找到 Codex CLI/);
    console.log(`安装初始化检查通过：${process.platform}，缺失的 Codex CLI 能得到明确提示`);
  } else {
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
  const flow = await evaluate(manage, `(async () => {
    const added = await window.api.core('addManualCard', {
      title: 'CI 交互卡', expiresAt: Math.floor(Date.now() / 1000) + 10 * 86400
    });
    const snooze = await window.api.core('scheduleSnooze', { cardId: added.id, option: '1d' });
    const scheduled = await window.api.core('snooze', { cardId: added.id });
    await window.api.core('clearSnooze', { cardId: added.id });
    const cleared = await window.api.core('snooze', { cardId: added.id });
    await window.api.core('markManualUsed', { cardId: added.id });
    const card = await window.api.core('getCard', { cardId: added.id });
    return { snooze: Boolean(snooze.targetAt && scheduled?.targetAt), cleared: !cleared,
      status: card.status };
  })()`);
  assert.deepEqual(flow, { snooze: true, cleared: true, status: 'used' });
  console.log('卡片管理、加卡、延期和已使用流程通过，检查设置窗口');
  // 打开新窗口后，旧窗口可能失焦；直接检查新窗口是否出现。
  await evaluate(manage, 'window.api.openSettings(); true');
  let settings;
  do {
    const tab = await page(port, '/ui/settings/index.html', child, deadline);
    settings = await evaluate(tab, `({bridge: Boolean(window.api), listener: document.querySelector('#listener-state')?.textContent,
      connection: document.querySelector('#feishu-state')?.textContent,
      diagnostics: document.querySelector('#diagnostics')?.textContent,
      updateButton: Boolean(document.querySelector('#check-updates'))})`);
    if (settings.listener?.includes('尚未配置机器人') && settings.connection?.includes('尚未连接')
      && settings.diagnostics?.includes('Codex CLI 路径')) break;
    await sleep(300);
  } while (Date.now() < deadline);
  assert.ok(settings.bridge, '设置窗口 preload 没有加载');
  assert.match(settings.listener, /尚未配置机器人/);
  assert.match(settings.connection, /尚未连接/);
  assert.match(settings.diagnostics, /Codex CLI 路径/);
  assert.ok(settings.updateButton, '检查更新入口未显示');
  const settingsTab = await page(port, '/ui/settings/index.html', child, deadline);
  await evaluate(settingsTab, 'window.api.testDesktopReminder(); true');
  const reminderTab = await page(port, '/ui/reminder/index.html', child, deadline);
  let reminder;
  do {
    reminder = await evaluate(reminderTab, `({name: document.querySelector('#name')?.textContent,
      expiry: document.querySelector('#expiry')?.textContent})`);
    if (reminder.name?.includes('演示重置卡') && reminder.expiry?.includes('到期时间')) break;
    await sleep(200);
  } while (Date.now() < deadline);
  assert.match(reminder.name, /演示重置卡/);
  assert.match(reminder.expiry, /到期时间/);
  // 关闭窗口会销毁发起 IPC 的页面，不等待这个页面上的 Promise 回执。
  await evaluate(reminderTab, `window.api.reminderAction('dismiss'); true`);
  console.log(`安装包交互检查通过：${process.platform}，加卡、延期、设置和桌面弹窗`);
  }
} catch (error) {
  console.error(error);
  if (logs) console.error(logs);
  process.exitCode = 1;
} finally {
  await stopTree(child);
  try { await rm(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 }); }
  catch (error) { console.error(`清理测试数据失败：${error.message}`); process.exitCode = 1; }
}
// Electron 的渲染子进程可能继承测试脚本的管道；完成清理后直接退出。
process.exit(process.exitCode || 0);
