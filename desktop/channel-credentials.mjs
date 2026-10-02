// 渠道 Token 只在主进程解密，配置和设置页仅保存凭据引用与状态。
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const credentialIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const configurationError = (message) => Object.assign(new Error(message), { code: 'PUSHPLUS_CONFIGURATION' });
function credentialPath(configPath, credentialId) {
  if (typeof credentialId !== 'string' || !credentialIdPattern.test(credentialId))
    throw new Error('微信凭据引用无效，请重新保存 Token');
  return join(dirname(configPath), 'channels', 'credentials', `pushplus-${credentialId}.bin`);
}
function requireEncryption(crypto) {
  if (!crypto?.isEncryptionAvailable?.()
    || (crypto.getSelectedStorageBackend && crypto.getSelectedStorageBackend() === 'basic_text'))
    throw configurationError('系统凭据保护不可用，请解锁系统钥匙串后重试');
}
export function validateWechatToken(value) {
  if (typeof value !== 'string') throw new Error('请填写有效的 PushPlus Token');
  const token = value.trim();
  if (token && (token.length > 256 || /[\s\u0000-\u001f\u007f]/.test(token)))
    throw new Error('请填写有效的 PushPlus Token');
  return token;
}
export async function wechatSettingsStatus(configPath, config) {
  const provider = config.wechat?.provider === 'pushplus' ? 'pushplus' : config.wechat ? 'legacy' : '';
  let configured = false;
  if (provider === 'pushplus') {
    try { configured = (await stat(credentialPath(configPath, config.wechat.credentialId))).isFile(); }
    catch { /* 配置状态不证明 Token 有效或消息已经送达。 */ }
  }
  return { wechatEnabled: config.wechat?.enabled === true, wechatConfigured: configured, wechatProvider: provider };
}
export async function readWechatToken(configPath, config, { crypto } = {}) {
  if (config.wechat?.provider !== 'pushplus') throw configurationError('请先配置微信 PushPlus 渠道');
  requireEncryption(crypto);
  try {
    const value = JSON.parse(crypto.decryptString(await readFile(credentialPath(configPath, config.wechat.credentialId))));
    if (value.version !== 1 || value.provider !== 'pushplus' || !validateWechatToken(value.token)) throw new Error('invalid');
    return value.token;
  } catch { throw configurationError('微信 Token 无法读取，请重新保存'); }
}
async function writeWechatToken(configPath, token, crypto) {
  requireEncryption(crypto);
  const credentialId = randomUUID();
  const path = credentialPath(configPath, credentialId);
  const temporary = `${path}.${randomUUID()}.tmp`;
  let encrypted;
  try { encrypted = crypto.encryptString(JSON.stringify({ version: 1, provider: 'pushplus', token })); }
  catch { throw new Error('微信 Token 无法加密，请检查系统凭据保护'); }
  try {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(temporary, encrypted, { mode: 0o600, flag: 'wx' });
    await rename(temporary, path);
  } catch { throw new Error('微信 Token 未保存，请检查本地目录权限'); }
  finally { await rm(temporary, { force: true }).catch(() => {}); }
  return credentialId;
}
async function removeCredential(configPath, credentialId) {
  try { await rm(credentialPath(configPath, credentialId), { force: true }); }
  catch { /* 清理失败不改变已经提交的配置。 */ }
}

// 新凭据先加密写入，再由 write 提交所有偏好；失败时保留旧引用和旧凭据。
export async function commitWechatSettings(configPath, config, input, write, { crypto } = {}) {
  const hasInputs = Object.hasOwn(input, 'wechatEnabled') || Object.hasOwn(input, 'wechatToken');
  const token = Object.hasOwn(input, 'wechatToken') ? validateWechatToken(input.wechatToken) : '';
  const isPushplus = config.wechat?.provider === 'pushplus';
  if (!hasInputs || (!isPushplus && input.wechatEnabled !== true && !token)) return write(config);
  const enabled = Object.hasOwn(input, 'wechatEnabled') ? input.wechatEnabled === true : config.wechat?.enabled === true;
  let credentialId = isPushplus ? config.wechat.credentialId : undefined;
  if (!token && enabled && !(await wechatSettingsStatus(configPath, config)).wechatConfigured)
    throw new Error('请先填写并保存 PushPlus Token');
  if (token) credentialId = await writeWechatToken(configPath, token, crypto);
  const candidate = { ...config, wechat: { ...config.wechat, enabled, provider: 'pushplus', ...(credentialId ? { credentialId } : {}) } };
  try { await write(candidate); }
  catch (error) {
    if (token) await removeCredential(configPath, credentialId);
    throw error;
  }
  if (token && isPushplus && config.wechat.credentialId !== credentialId)
    await removeCredential(configPath, config.wechat.credentialId);
}
