import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { callFeishuCli } from '../core/feishu.mjs';
import { quietHours } from '../core/reminder-policy.mjs';
import { autoStartEnabled, setAutoStart } from './autostart.mjs';
import { commitPreferences } from './preference-commit.mjs';

async function readConfig(path) { return JSON.parse(await readFile(path, 'utf8')); }
async function writeConfig(path, config) {
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  await rename(temporary, path);
}

export function discoverLarkScript() {
  const found = spawnSync(process.platform === 'win32' ? 'where.exe' : 'which', ['lark-cli'],
    { encoding: 'utf8', timeout: 5000, windowsHide: true });
  for (const raw of (found.stdout || '').split(/\r?\n/).filter(Boolean)) {
    const path = raw.trim();
    let script;
    try {
      script = process.platform === 'win32'
        ? join(dirname(path), 'node_modules', '@larksuite', 'cli', 'scripts', 'run.js')
        : realpathSync(path);
    } catch { continue; }
    if (existsSync(script) && /\.m?js$/i.test(script)) return script;
  }
  return '';
}

export async function readSettings(configPath, { discoverLark = true } = {}) {
  const config = await readConfig(configPath);
  return {
    autoStartEnabled: autoStartEnabled(),
    desktopEnabled: config.desktop?.enabled !== false,
    feishuEnabled: config.feishu?.enabled === true,
    feishuConnected: Boolean(config.feishu?.profile && config.feishu?.userId && config.larkCliScript),
    appId: config.feishu?.appId || '',
    recipientId: config.feishu?.recipientId || config.feishu?.userId || '',
    larkCliScript: config.larkCliScript || (discoverLark ? discoverLarkScript() : ''),
    quietEnabled: config.reminders?.quietHours?.enabled === true,
    quietStart: config.reminders?.quietHours?.start || '22:00',
    quietEnd: config.reminders?.quietHours?.end || '09:00',
    preflightEnabled: config.reminders?.preflightSync?.enabled !== false,
    retryMinutes: Number(config.reminders?.preflightSync?.retryMinutes || 60),
  };
}

export async function saveSettings(configPath, input) {
  const config = await readConfig(configPath);
  if (input.feishuEnabled && !(config.feishu?.profile && config.feishu?.userId && config.larkCliScript)) {
    throw new Error('请先连接飞书机器人');
  }
  const retryMinutes = Number(input.retryMinutes);
  if (!Number.isInteger(retryMinutes) || retryMinutes < 10 || retryMinutes > 1440) {
    throw new Error('提醒前核对间隔须在 10–1440 分钟之间');
  }
  config.desktop = { ...config.desktop, enabled: input.desktopEnabled === true };
  config.feishu = { ...config.feishu, enabled: input.feishuEnabled === true };
  config.reminders = { ...config.reminders,
    quietHours: { enabled: input.quietEnabled === true,
      start: input.quietStart, end: input.quietEnd },
    preflightSync: { enabled: input.preflightEnabled === true, retryMinutes },
  };
  quietHours(config);
  await commitPreferences({ previousAutoStart: autoStartEnabled(), nextAutoStart: input.autoStartEnabled === true,
    setAutoStart, write: () => writeConfig(configPath, config) });
  return readSettings(configPath, { discoverLark: false });
}

async function saveCliProfile(nodePath, script, appId, secret, profile) {
  const args = [script, 'config', 'init', '--force-init', '--name', profile,
    '--app-id', appId, '--app-secret-stdin'];
  await new Promise((resolve, reject) => {
    const child = spawn(nodePath, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdout.resume();
    child.stderr.resume();
    child.once('error', () => reject(new Error('无法启动飞书 CLI')));
    child.once('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error('飞书 CLI 保存机器人配置失败，请检查 App ID 和 App Secret'));
    });
    child.stdin.end(`${secret}\n`);
  });
}

export async function connectFeishu(configPath, input) {
  const appId = String(input.appId || '').trim();
  const recipientId = String(input.recipientId || '').trim();
  const secret = String(input.secret || '');
  const larkCliScript = String(input.larkCliScript || '').trim();
  if (!/^cli_[A-Za-z0-9]+$/.test(appId) || !/^(?:ou_|on_)[A-Za-z0-9]+$/.test(recipientId)) {
    throw new Error('请填写有效的飞书 App ID 和接收人 ID');
  }
  if (!secret || !existsSync(larkCliScript)) throw new Error('请填写 App Secret 和有效的 lark-cli 路径');
  const config = await readConfig(configPath);
  const nodePath = process.env.CODEX_RESET_MONITOR_NODE_PATH || config.nodePath || 'node';
  const profile = `codex-reset-monitor-${randomUUID().slice(0, 8)}`;
  await saveCliProfile(nodePath, larkCliScript, appId, secret, profile);
  const candidate = { ...config, nodePath, larkCliScript,
    feishu: { ...config.feishu, enabled: true, as: 'bot', profile, appId, recipientId } };
  let userId = recipientId;
  if (recipientId.startsWith('on_')) {
    const lookup = await callFeishuCli(candidate, ['contact', '+get-user', '--profile', profile,
      '--as', 'bot', '--user-id', recipientId, '--user-id-type', 'union_id', '--json']);
    userId = lookup.data?.user?.open_id;
    if (!/^ou_[A-Za-z0-9]+$/.test(userId || '')) throw new Error('未查到接收人的飞书 Open ID');
  }
  const sent = await callFeishuCli(candidate, ['im', '+messages-send', '--profile', profile,
    '--as', 'bot', '--user-id', userId,
    '--text', 'Codex 重置卡提醒已连接。后续到期提醒会发送到此私聊。', '--json']);
  if (!/^om_/.test(sent.data?.message_id || '')) throw new Error('飞书未确认测试私聊已送达');
  candidate.feishu.userId = userId;
  await writeConfig(configPath, candidate);
  return readSettings(configPath);
}
