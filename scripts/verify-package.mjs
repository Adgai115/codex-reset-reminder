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
  'ui/manage/index.html', 'ui/manage/app.mjs', 'ui/manage/view-model.mjs',
  'desktop/cli-repair.mjs', 'ui/setup/index.html', 'config.example.json']) {
  assert.ok(existsSync(join(appRoot, name)), `安装包缺少 ${name}`);
}
for (const name of ['config.json', '.state', '.env', 'data.db']) {
  assert.ok(!existsSync(join(appRoot, name)), `安装包包含用户数据 ${name}`);
}
const resources = dirname(appRoot);
assert.ok(existsSync(join(resources, 'vendor-node', process.platform === 'win32' ? 'node.exe' : 'node')),
  '安装包缺少 Node sidecar');
console.log(`安装包内容检查通过：${process.platform}`);
