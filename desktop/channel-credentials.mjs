// 渠道 Token 只在主进程解密，配置和设置页仅保存凭据引用与状态。
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, isAbsolute } from 'node:path';

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
  const provider = ['pushplus', 'local-gateway'].includes(config.wechat?.provider) ? config.wechat.provider : config.wechat ? 'legacy' : '';
  let configured = false;
  if (provider === 'pushplus') {
    try { configured = (await stat(credentialPath(configPath, config.wechat.credentialId))).isFile(); }
    catch { /* 配置状态不证明 Token 有效或消息已经送达。 */ }
  }
  if (provider === 'local-gateway') {
    try {
      const file = validateGatewayClientFile(config.wechat.gatewayClientFile);
      const info = await stat(file);
      configured = info.isFile() && info.size > 0 && info.size <= 65536;
    } catch { /* 文件存在不等于网关在线或微信送达。 */ }
  }
  return { wechatEnabled: config.wechat?.enabled === true, wechatConfigured: configured, wechatProvider: provider,
    ...(provider === 'local-gateway' ? { wechatGatewayClientFile: config.wechat.gatewayClientFile || '' } : {}) };
}
export function validateGatewayClientFile(value) {
  if (typeof value !== 'string') throw new Error('请选择本机微信网关的加密调用文件');
  const file = value.trim();
  if (!file || file.length > 4096 || !isAbsolute(file) || !/\.bin$/i.test(file) || /[\u0000-\u001f]/.test(file))
    throw new Error('请选择本机微信网关的加密调用文件');
  return file;
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
  if (input.wechatProvider === 'local-gateway') {
    const gatewayClientFile = String(input.wechatGatewayClientFile || config.wechat?.gatewayClientFile || '').trim();
    const enabled = input.wechatEnabled === true;
    if (gatewayClientFile) validateGatewayClientFile(gatewayClientFile);
    const candidate = { ...config, wechat: { ...config.wechat, enabled, provider: 'local-gateway', gatewayClientFile } };
    if (enabled && !(await wechatSettingsStatus(configPath, candidate)).wechatConfigured)
      throw new Error('请先选择微信网关导出的加密调用文件');
    return write(candidate);
  }
  if (Object.hasOwn(input, 'wechatProvider') && !['', 'pushplus', 'legacy'].includes(input.wechatProvider))
    throw new Error('微信渠道类型无效');
  const hasInputs = Object.hasOwn(input, 'wechatEnabled') || Object.hasOwn(input, 'wechatToken');
  const token = Object.hasOwn(input, 'wechatToken') ? validateWechatToken(input.wechatToken) : '';
  const isPushplus = config.wechat?.provider === 'pushplus';
  if (config.wechat?.provider === 'local-gateway' && input.wechatProvider === 'pushplus' && !token) {
    const candidate = { ...config, wechat: { ...config.wechat, enabled: input.wechatEnabled === true, provider: 'pushplus' } };
    if (candidate.wechat.enabled && !(await wechatSettingsStatus(configPath, candidate)).wechatConfigured)
      throw new Error('请先填写并保存 PushPlus Token');
    return write(candidate);
  }
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
  if (token && config.wechat?.credentialId && config.wechat.credentialId !== credentialId)
    await removeCredential(configPath, config.wechat.credentialId);
}
