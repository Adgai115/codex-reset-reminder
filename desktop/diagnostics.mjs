import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { callAppServer } from '../check.mjs';

// 只读检查；返回面向用户的摘要，不返回凭证或完整 Usage 数据。
export async function probeCodex(codexScript, { appServer = callAppServer, exists = existsSync } = {}) {
  if (!codexScript || !exists(codexScript)) {
    return { ok: false, message: '未找到 Codex CLI。请安装并登录后重新选择路径。' };
  }
  try {
    const result = await appServer(codexScript, 'account/rateLimits/read');
    if (!result || typeof result !== 'object') {
      return { ok: false, message: 'Codex Usage 未返回有效数据。' };
    }
    const credits = result.rateLimitResetCredits;
    if (!Number.isInteger(credits?.availableCount) || !Array.isArray(credits?.credits)) {
      return { ok: true, complete: false,
        message: 'Codex 已连接，但重置卡详情不完整；提醒会继续使用已有缓存。' };
    }
    return { ok: true, complete: credits.availableCount === credits.credits.length,
      availableCount: credits.availableCount,
      message: `Codex Usage 可读取，当前可用 ${credits.availableCount} 张重置卡。` };
  } catch (error) {
    return { ok: false, message: `读取 Codex Usage 失败：${error.message}` };
  }
}

export async function diagnoseLocal(configPath, listenerStatus, { exists = existsSync } = {}) {
  let config;
  try { config = JSON.parse(await readFile(configPath, 'utf8')); }
  catch { return { codex: '配置文件无法读取', feishu: '尚未配置', listener: '未启动' }; }
  const codex = config.codexScript && exists(config.codexScript)
    ? 'Codex CLI 路径有效' : 'Codex CLI 路径缺失或文件不存在';
  const feishu = !config.feishu?.enabled ? '飞书渠道已关闭'
    : !config.feishu?.profile || !config.feishu?.userId || !config.larkCliScript
      ? '飞书机器人配置不完整'
      : !exists(config.larkCliScript) ? '飞书 CLI 文件不存在' : '飞书配置已保存';
  const states = {
    listening: '飞书按钮监听运行中', retrying: '飞书按钮监听重试中',
    occupied: '飞书按钮监听被其他进程占用', disabled: '飞书按钮监听未运行',
    unconfigured: '飞书按钮监听配置不完整', starting: '飞书按钮监听正在启动',
  };
  return { codex, feishu, listener: states[listenerStatus?.state] || '飞书按钮监听状态未知' };
}
