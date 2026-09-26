// 在隔离的临时数据目录中启动已打包应用，检查真实渲染进程和 preload。
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
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

async function command(tab, method, params) {
  const socket = new WebSocket(tab.webSocketDebuggerUrl);
  const context = `${tab.url?.split('/ui/')[1] || tab.id} · ${method} · ${String(params?.expression || '').trim().slice(0, 120)}`;
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('无法连接渲染进程调试端口')), 5000);
      socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      socket.addEventListener('error', (error) => { clearTimeout(timer); reject(error); }, { once: true });
    });
    const id = 1;
    const result = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`渲染进程没有响应：${context}`)), 15000);
      socket.addEventListener('close', () => {
        clearTimeout(timer);
        reject(new Error(`调试窗口已关闭：${context}`));
      }, { once: true });
      socket.addEventListener('message', (event) => {
        const message = JSON.parse(event.data);
        if (message.id !== id) return;
        clearTimeout(timer);
        if (message.error || message.result?.exceptionDetails) reject(new Error(JSON.stringify(message.error || message.result.exceptionDetails)));
        else resolve(message.result);
      });
    });
    socket.send(JSON.stringify({ id, method, params }));
    return await result;
  } finally { socket.close(); }
}

async function evaluate(tab, expression) {
  return (await command(tab, 'Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result.value;
}

async function until(tab, expression, description) {
  const deadline = Date.now() + 12000;
  do {
    const value = await evaluate(tab, expression);
    if (value) return value;
    await sleep(200);
  } while (Date.now() < deadline);
  throw new Error(`界面未更新：${description}`);
}

async function screenshot(tab, name) {
  const directory = process.env.CODEX_RESET_SMOKE_SCREENSHOTS;
  if (!directory) return;
  await mkdir(directory, { recursive: true });
  const { data } = await command(tab, 'Page.captureScreenshot', { format: 'png' });
  await writeFile(join(directory, `${name}.png`), Buffer.from(data, 'base64'));
}

async function untilClosed(port, suffix) {
  const deadline = Date.now() + 15000;
  do {
    const tabs = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
    if (!tabs.some((tab) => tab.url?.endsWith(suffix))) return;
    await sleep(200);
  } while (Date.now() < deadline);
  throw new Error(`窗口未按预期关闭：${suffix}`);
}

const isDebuggerTimeout = (error) => /渲染进程没有响应|无法连接渲染进程调试端口/.test(error.message);

async function triggerWindow(tab, expression) {
  try { await evaluate(tab, expression); }
  catch (error) {
    if (!isDebuggerTimeout(error) && !error.message.startsWith('调试窗口已关闭')) throw error;
    // 窗口创建或销毁可能先于 CDP 回执；后续必须核对窗口出现/消失及数据，不能直接当作成功。
    console.log(`窗口操作未收到调试回执，继续核对操作结果：${tab.url?.split('/ui/')[1]}`);
  }
}

async function stopTree(child) {
  if (!child) return;
  if (process.platform === 'win32' && child.exitCode === null) {
    await new Promise((resolve) => spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'],
      { windowsHide: true, stdio: 'ignore' }).once('close', resolve));
  } else if (child.exitCode === null) {
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
const background = process.argv.includes('--background');
const nativeDialogs = process.platform === 'win32' && process.argv.includes('--native-dialogs');
let child;
let logs = '';
async function clickNative(name) {
  await new Promise((resolve, reject) => {
    const task = spawn('pwsh.exe', ['-NoProfile', '-NonInteractive', '-File',
      join(root, 'scripts', 'windows-click-dialog.ps1'), '-TargetPid', String(child.pid), '-ButtonName', name],
    { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    const timer = setTimeout(() => { task.kill(); reject(new Error(`原生按钮操作超时：${name}`)); }, 20000);
    task.stdout.on('data', (chunk) => { output += chunk; });
    task.stderr.on('data', (chunk) => { output += chunk; });
    task.once('error', (error) => { clearTimeout(timer); reject(error); });
    task.once('close', (code) => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(output)); });
  });
}
try {
  const appPath = await executable();
  assert.ok(existsSync(appPath), `安装包程序不存在：${appPath}`);
  // 用隔离的假卡和不存在的 Codex 命令，保证测试不会消耗真实卡或发送消息。
  if (!setupOnly) {
    process.env.CODEX_RESET_MONITOR_DATA_DIR = profile;
    const { openStore, addManualCard } = await import('../core/store.mjs');
    const db = openStore();
    try {
      const now = Math.floor(Date.now() / 1000);
      addManualCard(db, { title: 'CI 演示重置卡', expiresAt: now + 10 * 86400 });
      addManualCard(db, { title: 'CI 即将到期卡', expiresAt: now + 3600 });
      const expired = addManualCard(db, { title: 'CI 过期卡', expiresAt: now + 60 });
      db.prepare('UPDATE cards SET expires_at = ? WHERE id = ?').run(now - 60, expired);
    }
    finally { db.close(); }
    const config = JSON.parse(await readFile(join(root, 'config.example.json'), 'utf8'));
    config.codexScript = join(profile, 'codex-does-not-exist');
    config.desktop.enabled = false;
    config.feishu.enabled = false;
    await writeFile(join(profile, 'config.json'), JSON.stringify(config));
  }
  const port = await freePort();
  // CI 的 Linux 解包目录不能把 chrome-sandbox 设为 root:4755；仅测试进程关闭沙盒。
  const testFlags = process.platform === 'linux' ? ['--no-sandbox', '--disable-gpu'] : [];
  const testEnv = { ...process.env, CODEX_RESET_MONITOR_USER_DATA_DIR: profile,
    CODEX_RESET_MONITOR_SKIP_MIGRATION: '1', CODEX_RESET_MONITOR_DATA_DIR: profile };
  const reopen = async () => {
    await new Promise((resolve, reject) => {
      const second = spawn(appPath, testFlags, { env: testEnv, windowsHide: true, stdio: 'ignore' });
      const timer = setTimeout(() => { second.kill(); reject(new Error('第二实例未交还已有窗口')); }, 10000);
      second.once('error', (error) => { clearTimeout(timer); reject(error); });
      second.once('close', (code) => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`第二实例退出：${code}`)); });
    });
  };
  child = spawn(appPath, [`--remote-debugging-port=${port}`, '--enable-logging', ...testFlags, ...(background ? ['--background'] : [])], {
    detached: process.platform !== 'win32',
    env: testEnv,
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  child.stdout.on('data', (chunk) => { logs = (logs + chunk.toString()).slice(-10000); });
  child.stderr.on('data', (chunk) => { logs = (logs + chunk.toString()).slice(-10000); });
  console.log(`已启动 ${process.platform} 安装包，等待${setupOnly ? '安装与连接' : '卡片管理'}窗口`);
  const deadline = Date.now() + 120000;
  if (background && !setupOnly) {
    let tabs;
    while (Date.now() < deadline) {
      try { tabs = await (await fetch(`http://127.0.0.1:${port}/json`, { signal: AbortSignal.timeout(1000) })).json(); break; }
      catch { await sleep(200); }
    }
    assert.ok(tabs, '后台启动没有就绪');
    await sleep(1500);
    tabs = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
    assert.equal(tabs.filter((tab) => tab.type === 'page').length, 0, '后台自启不应弹出管理窗口');
    await reopen();
    console.log('后台自启保持安静，再次启动可恢复同一实例的窗口');
  }
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
    await screenshot(setup, 'setup');
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
  const visible = await evaluate(manage, `({
    expired: document.querySelector('#cards tbody').textContent.includes('CI 过期卡'),
    nearDisabled: Array.from(document.querySelectorAll('#cards tbody tr')).find(row => row.textContent.includes('CI 即将到期卡'))?.querySelector('button')?.disabled,
    overflow: document.documentElement.scrollWidth > window.innerWidth
  })`);
  assert.deepEqual(visible, { expired: false, nearDisabled: true, overflow: false });
  // 实际点击表单，验证错误显示在模态框内，并且允许修正后保存。
  await evaluate(manage, `document.querySelector('#add').click();
    document.querySelector('#card-title').value = 'CI 表单卡';
    document.querySelector('#card-expiry').value = '2020-01-01T10:00';
    document.querySelector('#save-card').click(); true`);
  assert.equal(await evaluate(manage, `document.querySelector('#card-dialog').open && document.querySelector('#card-error').textContent.includes('晚于现在')`), true);
  await screenshot(manage, 'validation');
  await evaluate(manage, `(() => {
    const date = new Date(Date.now() + 10 * 86400000);
    document.querySelector('#card-expiry').value = new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0,16);
    document.querySelector('#save-card').click(); return true;
  })()`);
  await until(manage, `!document.querySelector('#card-dialog').open && document.querySelector('#cards tbody').textContent.includes('CI 表单卡')`, '新增手动卡');
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
  await until(manage, `document.querySelector('#history-filter').textContent.includes('2')`, '后台操作后列表自动刷新');
  await evaluate(manage, `document.querySelector('#history-filter').click(); true`);
  assert.equal(await evaluate(manage, `document.querySelector('#cards tbody').textContent.includes('CI 过期卡') && document.querySelector('#cards tbody').textContent.includes('已使用')`), true);
  await evaluate(manage, `document.querySelector('#active-filter').click(); true`);
  await until(manage, `!document.querySelector('#sync').disabled`, '启动同步结束');
  assert.equal(await evaluate(manage, `document.querySelector('#sync').click(); document.querySelector('#sync').textContent`), '同步中…');
  await until(manage, `!document.querySelector('#sync').disabled && document.querySelector('#notice').textContent.includes('同步失败')`, '同步失败后恢复按钮和缓存列表');
  await screenshot(manage, 'manage');
  console.log('卡片管理、加卡、延期和已使用流程通过，检查设置窗口');
  // 打开新窗口后，旧窗口可能失焦；直接检查新窗口是否出现。
  await triggerWindow(manage, 'window.api.openSettings(); true');
  console.log('已请求设置窗口，等待页面与本地诊断');
  let settings;
  do {
    const tab = await page(port, '/ui/settings/index.html', child, deadline);
    try {
      settings = await evaluate(tab, `({bridge: Boolean(window.api), listener: document.querySelector('#listener-state')?.textContent,
        connection: document.querySelector('#feishu-state')?.textContent,
        diagnostics: document.querySelector('#diagnostics')?.textContent,
        updateButton: Boolean(document.querySelector('#check-updates'))})`);
    } catch (error) {
      if (!isDebuggerTimeout(error) || Date.now() >= deadline) throw error;
      continue;
    }
    if (settings.listener?.includes('尚未配置机器人') && settings.connection?.includes('尚未连接')
      && settings.diagnostics?.includes('Codex CLI 路径')) break;
    await sleep(300);
  } while (Date.now() < deadline);
  assert.ok(settings.bridge, '设置窗口 preload 没有加载');
  assert.match(settings.listener, /尚未配置机器人/);
  assert.match(settings.connection, /尚未连接/);
  assert.match(settings.diagnostics, /Codex CLI 路径/);
  assert.ok(settings.updateButton, '检查更新入口未显示');
  console.log('设置窗口已显示，检查测试弹窗');
  const settingsTab = await page(port, '/ui/settings/index.html', child, deadline);
  const form = await evaluate(settingsTab, `(() => {
    document.querySelector('#quiet').checked = true;
    document.querySelector('#quiet').dispatchEvent(new Event('input', {bubbles:true}));
    document.querySelector('#quiet-start').value = '09:00';
    document.querySelector('#quiet-end').value = '09:00';
    document.querySelector('#save').click();
    return { error: document.querySelector('#status').textContent, footerVisible: document.querySelector('footer').getBoundingClientRect().bottom <= window.innerHeight + 1 };
  })()`);
  assert.match(form.error, /不能相同/);
  assert.equal(form.footerVisible, true);
  await evaluate(settingsTab, `document.querySelector('#quiet').checked = false;
    document.querySelector('#quiet').dispatchEvent(new Event('input', {bubbles:true})); true`);
  assert.equal(await evaluate(settingsTab, `document.querySelector('#quiet-start').disabled`), true);
  await screenshot(settingsTab, 'settings');
  console.log('设置表单校验通过，正在创建演示提醒');
  if (nativeDialogs) {
    await evaluate(settingsTab, `document.querySelector('#cancel').click(); true`);
    await clickNative('继续编辑');
    assert.equal(await evaluate(settingsTab, `document.querySelector('#quiet').checked`), false);
  }
  await triggerWindow(settingsTab, 'window.api.testDesktopReminder(); true');
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
  await screenshot(reminderTab, 'reminder');
  console.log('演示提醒内容已显示，检查关闭弹窗与保存设置');
  // 关闭会销毁调用方页面；确认窗口消失，不把丢失 CDP 回执误判为应用卡住。
  await triggerWindow(reminderTab, `document.querySelector('#close').click(); true`);
  await untilClosed(port, '/ui/reminder/index.html');
  // 保存只修改隔离配置，系统自启开关保持读取值，不注册测试启动项。
  await triggerWindow(settingsTab, `document.querySelector('#save').click(); true`);
  await untilClosed(port, '/ui/settings/index.html');
  assert.equal(await evaluate(manage, `Boolean(window.api) && document.querySelector('#cards tbody').textContent.includes('CI 表单卡')`), true);
  const saved = JSON.parse(await readFile(join(profile, 'config.json'), 'utf8'));
  assert.equal(saved.reminders.quietHours.enabled, false);
  assert.equal(saved.desktop.enabled, false);
  assert.equal(saved.feishu.enabled, false);
  if (nativeDialogs) {
    await clickNative('__close_manage__');
    await clickNative('收起到托盘');
    await until(manage, 'document.hidden', '关闭后收起到托盘');
    await reopen();
    await until(manage, '!document.hidden', '再次启动恢复管理窗口');
    await clickNative('__close_manage__');
    await clickNative('退出应用');
    const stoppedAt = Date.now() + 10000;
    while (child.exitCode === null && Date.now() < stoppedAt) await sleep(100);
    assert.equal(child.exitCode, 0, '明确退出后主进程应结束');
    console.log('Windows 原生确认、收起到托盘、恢复和退出通过');
  }
  assert.ok(!/Uncaught (?:SyntaxError|TypeError|ReferenceError)|UnhandledPromiseRejection/.test(logs), '运行中出现未处理脚本错误');
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
