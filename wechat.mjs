import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = dirname(fileURLToPath(import.meta.url));
const fields = new Set(['cardName', 'cardId', 'expiresAt', 'remainingDays', 'availableCount']);

export function buildWechatTemplate(config, card, days, { currentAvailableCount = null } = {}) {
  const settings = config.wechat;
  if (!settings?.enabled || !settings.openId || !settings.templateId) {
    throw new Error('公众号通知缺少接收人或模板配置');
  }
  const values = {
    cardName: card.title,
    cardId: card.id,
    expiresAt: new Date(card.expiresAt * 1000).toLocaleString('zh-CN', { hour12: false }),
    remainingDays: String(days),
    availableCount: currentAvailableCount === null ? '待同步' : String(currentAvailableCount),
  };
  const entries = Object.entries(settings.fieldMap || {});
  if (!entries.length || entries.some(([key, source]) => !/^[a-z]+\d+$/i.test(key) || !fields.has(source))) {
    throw new Error('公众号模板字段映射尚未配置');
  }
  return { touser: settings.openId, template_id: settings.templateId,
    data: Object.fromEntries(entries.map(([key, source]) => [key, { value: values[source] }])) };
}

export async function sendWechatReminder(config, card, days, options = {}) {
  const payload = buildWechatTemplate(config, card, days, options);
  const pwsh = config.pwshPath || 'pwsh.exe';
  return new Promise((resolve, reject) => {
    const child = spawn(pwsh, ['-NoProfile', '-NonInteractive', '-File', join(directory, 'wechat-send.ps1')],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout = (stdout + chunk.toString()).slice(-4096); });
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk.toString()).slice(-4096); });
    child.once('error', reject);
    child.stdin.on('error', reject);
    child.once('close', (code) => {
      if (code !== 0) return reject(new Error(stderr.trim() || '公众号发送失败'));
      try {
        const result = JSON.parse(stdout);
        if (!result.ok) throw new Error('公众号发送失败');
        resolve(result);
      } catch { reject(new Error('公众号响应格式无效')); }
    });
    child.stdin.end(JSON.stringify(payload));
  });
}
