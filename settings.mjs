import { randomUUID } from 'node:crypto';
import { readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { quietHours } from './reminder-policy.mjs';

const directory = dirname(fileURLToPath(import.meta.url));
const defaultPath = join(directory, 'config.json');

export function viewSettings(config) {
  const validClock = (value, fallback) => typeof value === 'string'
    && /^([01]\d|2[0-3]):[0-5]\d$/.test(value) ? value : fallback;
  const retry = config.reminders?.preflightSync?.retryMinutes;
  return {
    desktopEnabled: config.desktop?.enabled !== false,
    feishuEnabled: config.feishu?.enabled === true,
    feishuConfigured: config.feishu?.as === 'bot' && Boolean(config.feishu?.userId),
    quietEnabled: config.reminders?.quietHours?.enabled === true,
    quietStart: validClock(config.reminders?.quietHours?.start, '22:00'),
    quietEnd: validClock(config.reminders?.quietHours?.end, '09:00'),
    preflightEnabled: config.reminders?.preflightSync?.enabled !== false,
    retryMinutes: Number.isInteger(retry) && retry >= 5 && retry <= 1440 ? retry : 60,
  };
}

export function mergeSettings(config, input) {
  const boolFields = ['desktopEnabled', 'feishuEnabled', 'quietEnabled', 'preflightEnabled'];
  if (boolFields.some((field) => typeof input?.[field] !== 'boolean')) {
    throw new Error('通知设置缺少有效的开关值');
  }
  if (!Number.isInteger(input.retryMinutes) || input.retryMinutes < 5 || input.retryMinutes > 1440) {
    throw new Error('提醒前核对间隔必须为 5～1440 分钟');
  }
  if (input.feishuEnabled && (config.feishu?.as !== 'bot' || !config.feishu?.userId)) {
    throw new Error('请先配置飞书机器人私聊，再开启飞书提醒');
  }
  const next = structuredClone(config);
  next.desktop = { ...next.desktop, enabled: input.desktopEnabled };
  next.feishu = { ...next.feishu, enabled: input.feishuEnabled };
  next.reminders = {
    ...next.reminders,
    quietHours: { ...next.reminders?.quietHours, enabled: input.quietEnabled,
      start: input.quietStart, end: input.quietEnd },
    preflightSync: { ...next.reminders?.preflightSync, enabled: input.preflightEnabled,
      retryMinutes: input.retryMinutes },
  };
  quietHours({ reminders: { quietHours: { ...next.reminders.quietHours, enabled: true } } });
  return next;
}

export async function saveSettings(input, configPath = defaultPath) {
  const current = JSON.parse(await readFile(configPath, 'utf8'));
  const next = mergeSettings(current, input);
  const tempPath = `${configPath}.${randomUUID()}.tmp`;
  try {
    await writeFile(tempPath, `${JSON.stringify(next, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    await rename(tempPath, configPath);
  } catch (error) {
    await unlink(tempPath).catch(() => {});
    throw error;
  }
  return viewSettings(next);
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  try {
    const operation = process.argv[2];
    if (operation === 'get') {
      console.log(JSON.stringify(viewSettings(JSON.parse(await readFile(defaultPath, 'utf8')))));
    } else if (operation === 'apply') {
      const encoded = process.argv[3];
      if (!encoded || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) throw new Error('缺少设置内容');
      const input = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
      console.log(JSON.stringify(await saveSettings(input)));
    } else {
      throw new Error('用法：settings.mjs get | apply <base64-json>');
    }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
