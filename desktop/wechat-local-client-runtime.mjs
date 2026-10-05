import { isAbsolute } from 'node:path';
import { LOCAL_WECHAT_INPUT_LIMIT, localWechatFailure, readLimitedLocalFile,
  requestLocalWechatNotification, validLocalWechatClient, validLocalWechatRequest } from '../core/wechat-local-http.mjs';
import { decodeLocalWechatBundle } from './wechat-local-export.mjs';

export function parseLocalWechatHelperArguments(argv) {
  let clientFile, mode = 'notify';
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === '--wechat-local-client-helper') continue;
    if (argument === '--client-file' && !clientFile) { clientFile = argv[++index]; continue; }
    if (argument === '--status' && mode === 'notify') { mode = 'status'; continue; }
    throw new Error('LOCAL_ARGUMENTS_INVALID');
  }
  if (typeof clientFile !== 'string' || !isAbsolute(clientFile)) throw new Error('LOCAL_ARGUMENTS_INVALID');
  return { clientFile, mode };
}

export async function readLocalWechatInput(stream, { limit = LOCAL_WECHAT_INPUT_LIMIT, timeoutMs = 10000 } = {}) {
  let timer;
  const operation = (async () => {
    const chunks = [];
    let length = 0;
    for await (const chunk of stream) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8');
      length += bytes.length;
      if (length > limit) throw new Error('LOCAL_INPUT_INVALID');
      chunks.push(bytes);
    }
    const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, length)).replace(/^\uFEFF/, '');
    const request = JSON.parse(text);
    if (!validLocalWechatRequest(request)) throw new Error('LOCAL_INPUT_INVALID');
    return request;
  })();
  try {
    return await Promise.race([operation, new Promise((_, reject) => {
      timer = setTimeout(() => { stream.destroy?.(); reject(new Error('LOCAL_INPUT_INVALID')); }, timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
}

export async function runLocalWechatClient({ clientFile, request, mode = 'notify', crypto,
  fetchImpl, signal, timeoutMs, readFileImpl = readLimitedLocalFile } = {}) {
  if (typeof clientFile !== 'string' || !isAbsolute(clientFile) || !['notify', 'status'].includes(mode)
    || (mode === 'notify' && !validLocalWechatRequest(request)))
    return localWechatFailure('WECHAT_LOCAL_CONFIGURATION', request);
  if (!crypto?.isEncryptionAvailable?.() || crypto.getSelectedStorageBackend?.() === 'basic_text')
    return localWechatFailure('WECHAT_LOCAL_CREDENTIALS', request);
  let client;
  try {
    const bytes = await readFileImpl(clientFile, 65536);
    if (!Buffer.isBuffer(bytes) || bytes.length > 65536) throw new Error('invalid');
    client = JSON.parse(crypto.decryptString(decodeLocalWechatBundle(bytes).encrypted));
    if (!validLocalWechatClient(client)) throw new Error('invalid');
  } catch { return localWechatFailure('WECHAT_LOCAL_CREDENTIALS', request); }
  return requestLocalWechatNotification(client, request, { fetchImpl, signal, timeoutMs, mode, readFileImpl });
}
