// 检查目录包的必需文件，并防止本机配置或数据库混入公开安装包。
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');

async function appDirectory() {
  if (process.platform === 'win32') return join(dist, 'win-unpacked', 'resources', 'app');
  if (process.platform === 'linux') return join(dist, 'linux-unpacked', 'resources', 'app');
  for (const item of await readdir(dist, { withFileTypes: true })) {
    if (!item.isDirectory() || !item.name.startsWith('mac')) continue;
    const bundle = (await readdir(join(dist, item.name))).find((name) => name.endsWith('.app'));
    if (bundle) return join(dist, item.name, bundle, 'Contents', 'Resources', 'app');
  }
  throw new Error('未找到 macOS 目录包');
}

const appRoot = await appDirectory();
for (const name of ['desktop/main.mjs', 'desktop/diagnostics.mjs', 'core/store.mjs',
  'legacy/node/sync.mjs', 'legacy/node/check.mjs', 'legacy/node/remind.mjs',
  'ui/manage/index.html', 'ui/manage/app.mjs', 'ui/manage/view-model.mjs',
  'ui/settings/index.html', 'ui/settings/accounts.mjs',
  'desktop/cli-repair.mjs', 'desktop/reminder-items.mjs', 'desktop/reset-card.mjs', 'core/pending-reminders.mjs',
  'desktop/account-guard.mjs', 'desktop/account-sessions.mjs', 'desktop/codex-session.mjs',
  'desktop/channel-credentials.mjs', 'core/pushplus.mjs', 'core/pushplus-http.mjs',
  'core/wechat-local-reminder.mjs', 'core/wechat-local-client.mjs', 'core/wechat-local-http.mjs', 'core/wechat-local-bridge.mjs',
  'desktop/wechat-local-client-main.mjs', 'desktop/wechat-local-client-runtime.mjs', 'desktop/wechat-local-export.mjs',
  'ui/reminder/index.html', 'ui/reminder/app.mjs', 'ui/setup/index.html', 'config.example.json']) {
  assert.ok(existsSync(join(appRoot, name)), `安装包缺少 ${name}`);
}
for (const name of ['config.json', '.state', '.env', 'data.db', 'channels', 'accounts', 'scripts', 'gateway-state.bin', 'session.bin']) {
  assert.ok(!existsSync(join(appRoot, name)), `安装包包含用户数据 ${name}`);
}
const resources = dirname(appRoot);
if (process.platform === 'win32') {
  assert.ok(existsSync(join(resources, 'app-update.yml')), 'Windows 安装包缺少更新来源配置');
  assert.ok(existsSync(join(appRoot, 'node_modules', 'electron-updater')), 'Windows 安装包缺少更新组件');
}
assert.ok(existsSync(join(resources, 'vendor-node', process.platform === 'win32' ? 'node.exe' : 'node')),
  '安装包缺少 Node sidecar');
console.log(`安装包内容检查通过：${process.platform}`);
