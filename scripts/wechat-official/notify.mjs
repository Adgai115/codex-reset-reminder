import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { invokeWechatLocalClient } from '../../core/wechat-local-client.mjs';
import { localWechatFailure } from '../../core/wechat-local-http.mjs';
import { readLocalWechatInput } from '../../desktop/wechat-local-client-runtime.mjs';

export function parseNotifyArguments(argv) {
  let clientFile, electronPath, stdin = false, status = false;
  for (let index = 0; index < argv.length; index++) {
    const value = argv[index];
    if (value === '--client-file' && !clientFile) { clientFile = argv[++index]; continue; }
    if (value === '--electron-path' && !electronPath) { electronPath = argv[++index]; continue; }
    if (value === '--stdin' && !stdin) { stdin = true; continue; }
    if (value === '--status' && !status) { status = true; continue; }
    throw new Error('LOCAL_ARGUMENTS_INVALID');
  }
  if (typeof clientFile !== 'string' || !clientFile || stdin === status
    || (electronPath !== undefined && (typeof electronPath !== 'string' || !electronPath)))
    throw new Error('LOCAL_ARGUMENTS_INVALID');
  return { clientFile: resolve(clientFile), ...(electronPath ? { electronPath: resolve(electronPath) } : {}), mode: status ? 'status' : 'notify' };
}

export async function notifyCli({ argv = process.argv.slice(2), input = process.stdin,
  invoke = invokeWechatLocalClient, resolveElectron = () => createRequire(import.meta.url)('electron') } = {}) {
  try {
    const options = parseNotifyArguments(argv);
    const request = options.mode === 'notify' ? await readLocalWechatInput(input) : undefined;
    return await invoke({ ...options, electronPath: options.electronPath || resolveElectron(), request });
  } catch { return localWechatFailure('WECHAT_LOCAL_CONFIGURATION'); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const result = await notifyCli();
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = ['accepted', 'status'].includes(result.state) ? 0 : result.state === 'unknown' || result.state === 'pending' ? 2 : 1;
}
