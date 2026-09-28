import { spawnSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';
import { app, dialog } from 'electron';
import { callAppServer } from '../check.mjs';
import { stopLegacyTasks } from './legacy-tasks.mjs';

function nodeRuntime() {
  return app.isPackaged
    ? join(process.resourcesPath, 'vendor-node', process.platform === 'win32' ? 'node.exe' : 'node')
    : process.env.CODEX_RESET_MONITOR_NODE_PATH || 'node';
}

export function discoverCodexScript() {
  const command = process.platform === 'win32' ? 'where.exe' : 'which';
  const found = spawnSync(command, ['codex'], { encoding: 'utf8', timeout: 5000, windowsHide: true });
  for (const raw of (found.stdout || '').split(/\r?\n/).filter(Boolean)) {
    const path = raw.trim();
    let candidates;
    try {
      candidates = process.platform === 'win32'
        ? [join(dirname(path), 'node_modules', '@openai', 'codex', 'bin', 'codex.js'), path]
        : [realpathSync(path)];
    } catch { continue; }
    for (const candidate of candidates) {
      if (existsSync(candidate) && (candidate.endsWith('.js') || extname(candidate).toLowerCase() === '.exe'
        || process.platform !== 'win32')) return candidate;
    }
  }
  return '';
}

export function findLegacyInstall() {
  if (process.platform !== 'win32') return null;
  const task = spawnSync('schtasks.exe', ['/Query', '/TN', 'CodexResetCardSync', '/XML'],
    { encoding: 'utf8', timeout: 7000, windowsHide: true });
  const candidates = [...(task.stdout || '').matchAll(/([A-Za-z]:\\[^"<>\r\n]+?\\(?:run-hidden\.vbs|run-sync\.ps1))/gi)];
  for (const match of candidates) {
    const root = dirname(match[1]);
    if (existsSync(join(root, '.state', 'data.db')) && existsSync(join(root, 'config.json'))) return root;
  }
  return null;
}

export async function migrateLegacy(root, userData) {
  const oldDb = join(root, '.state', 'data.db');
  const oldConfig = join(root, 'config.json');
  await mkdir(userData, { recursive: true });
  const targetDb = join(userData, 'data.db');
  const targetConfig = join(userData, 'config.json');
  const marker = join(userData, 'migration.json');
  if ((!existsSync(targetDb) && !existsSync(oldDb))
    || (!existsSync(targetConfig) && !existsSync(oldConfig))) {
    throw new Error('迁移来源或目标数据不完整');
  }
  let previous = null;
  if (existsSync(marker)) previous = JSON.parse(await readFile(marker, 'utf8'));
  if (previous && previous.source !== root) throw new Error('迁移来源与已有记录不一致');
  if (!previous && (existsSync(targetDb) || existsSync(targetConfig))) {
    throw new Error('新数据目录已有数据，已停止迁移以防覆盖');
  }
  if (!previous) {
    await writeFile(marker, JSON.stringify({ source: root, phase: 'pending', taskFailures: [] }, null, 2),
      { flag: 'wx' });
  }
  if (!existsSync(targetDb)) {
    const backup = spawnSync(nodeRuntime(), [join(import.meta.dirname, 'backup-db.mjs'), oldDb, targetDb],
      { encoding: 'utf8', timeout: 30000, windowsHide: true });
    if (backup.status !== 0) {
      await unlink(targetDb).catch((error) => { if (error.code !== 'ENOENT') throw error; });
      throw new Error(`数据库备份失败：${backup.error?.message || backup.stderr?.trim() || backup.status}`);
    }
  }
  if (!existsSync(targetConfig)) {
    const config = JSON.parse(await readFile(oldConfig, 'utf8'));
    if (config.wechat) config.wechat.enabled = false; // 微信渠道暂未移植到桌面版。
    await writeFile(targetConfig, `${JSON.stringify(config, null, 2)}\n`, { flag: 'wx' });
  }
  const taskFailures = stopLegacyTasks();
  await writeFile(marker, JSON.stringify({ source: root,
    phase: taskFailures.length ? 'pending' : 'complete',
    migratedAt: taskFailures.length ? null : new Date().toISOString(), taskFailures }, null, 2));
  return { taskFailures };
}

export async function initializeConfig({ codexScript, configPath, examplePath }) {
  if (!String(codexScript || '').trim()) throw new Error('请先选择 Codex CLI');
  const script = resolve(String(codexScript).trim());
  if (!existsSync(script)) throw new Error('找不到 Codex CLI，请先安装并登录 Codex CLI');
  const result = await callAppServer(script, 'account/rateLimits/read');
  if (!result || typeof result !== 'object') throw new Error('Codex Usage 未返回数据');
  const config = JSON.parse(await readFile(examplePath, 'utf8'));
  config.codexScript = script;
  config.nodePath = nodeRuntime();
  await mkdir(dirname(configPath), { recursive: true });
  const temporary = `${configPath}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  await rename(temporary, configPath);
  return { connected: true };
}

export async function offerLegacyMigration(userData) {
  const root = findLegacyInstall();
  if (!root) return 'none';
  const { response } = await dialog.showMessageBox({
    type: 'question', title: '迁移 Windows 旧版数据',
    message: '检测到旧版 Codex 重置卡提醒',
    detail: `位置：${root}\n\n迁移会复制卡片、提醒记录和飞书配置，并停用旧计划任务，避免重复提醒。`,
    buttons: ['迁移并停用旧任务', '暂不迁移（退出）'], defaultId: 0, cancelId: 1,
  });
  if (response !== 0) return 'declined';
  await migrateLegacy(root, userData);
  return 'migrated';
}

export async function ensureLegacyMigrationReady(userData) {
  if (process.platform !== 'win32' || process.env.CODEX_RESET_MONITOR_SKIP_MIGRATION === '1') return true;
  const marker = join(userData, 'migration.json');
  while (true) {
    // 旧任务也可能在新版配置已存在后重新启用，因此每次启动都确认一次。
    const taskFailures = existsSync(marker)
      ? (await migrateLegacy(JSON.parse(await readFile(marker, 'utf8')).source, userData)).taskFailures
      : stopLegacyTasks();
    if (!taskFailures.length) return true;
    const { response } = await dialog.showMessageBox({
      type: 'warning', title: '旧版提醒任务仍在运行',
      message: '旧版计划任务尚未停用，暂不能启动新版提醒',
      detail: `请先停用这些旧任务：${taskFailures.join('、')}。\n重启应用后会重新检查，避免重复提醒。`,
      buttons: ['重试停用旧任务', '退出应用'], defaultId: 0, cancelId: 1,
    });
    if (response !== 0) return false;
  }
}
