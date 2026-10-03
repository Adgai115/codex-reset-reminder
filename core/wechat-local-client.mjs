import { spawn } from 'node:child_process';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LOCAL_WECHAT_INPUT_LIMIT, localWechatFailure, sanitizeLocalWechatResult,
  validLocalWechatRequest } from './wechat-local-http.mjs';
import { createLocalClientBridge } from './wechat-local-bridge.mjs';

const helper = join(dirname(fileURLToPath(import.meta.url)), '..', 'desktop', 'wechat-local-client-main.mjs');
export const LOCAL_WECHAT_HELPER_TIMEOUT = 95000;

// Only the Electron child can decrypt the client capability. Message content is
// supplied on stdin, never in process arguments, shell commands, or diagnostics.
export function invokeWechatLocalClient({ electronPath, clientFile, request, mode = 'notify',
  signal, timeoutMs = LOCAL_WECHAT_HELPER_TIMEOUT, spawnImpl = spawn } = {}) {
  if (typeof electronPath !== 'string' || !electronPath || typeof clientFile !== 'string'
    || !isAbsolute(clientFile) || !['notify', 'status'].includes(mode)
    || (mode === 'notify' && !validLocalWechatRequest(request)))
    return Promise.resolve(localWechatFailure('WECHAT_LOCAL_CONFIGURATION', request));
  if (signal?.aborted) return Promise.resolve(localWechatFailure('WECHAT_LOCAL_CANCELLED', request));
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const args = [helper, '--wechat-local-client-helper', '--client-file', clientFile,
    ...(mode === 'status' ? ['--status'] : [])];
  return new Promise((resolve) => {
    let child, bridge, completed = false, bytes = 0, timer;
    const output = [];
    const unknown = () => localWechatFailure(mode === 'status' ? 'WECHAT_LOCAL_OFFLINE' : 'WECHAT_UNKNOWN', request);
    const finish = (result, kill = false) => {
      if (completed) return;
      completed = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancelled);
      if (kill) { try { child?.kill(); } catch { /* No private subprocess errors are returned. */ } }
      Promise.resolve(bridge?.close()).catch(() => {}).finally(() => resolve(result));
    };
    const cancelled = () => finish(unknown(), true);
    createLocalClientBridge({ request, mode, onResult: (result) => finish(result) }).then((control) => {
    bridge = control;
    if (completed || signal?.aborted) { finish(localWechatFailure('WECHAT_LOCAL_CANCELLED', request)); return; }
    try {
      child = spawnImpl(electronPath, args, { env: { ...env, ...bridge.env }, windowsHide: true, shell: false,
        stdio: ['pipe', 'pipe', 'pipe'] });
    } catch { finish(localWechatFailure('WECHAT_LOCAL_HELPER_UNAVAILABLE', request)); return; }
    child.once('error', () => finish(localWechatFailure('WECHAT_LOCAL_HELPER_UNAVAILABLE', request)));
    child.stdout?.on('data', (chunk) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > LOCAL_WECHAT_INPUT_LIMIT) { finish(unknown(), true); return; }
      output.push(Buffer.from(chunk));
    });
    // Electron may emit native warnings. Never expose this stream to callers.
    child.stderr?.on('data', () => {});
    child.stdin?.once('error', () => finish(unknown(), true));
    child.once('close', () => {
      if (completed) return;
      let value;
      try { value = sanitizeLocalWechatResult(JSON.parse(Buffer.concat(output, bytes).toString('utf8').trim()), { request, mode }); }
      catch { /* A crashed helper may have submitted before returning a receipt. */ }
      finish(value || unknown());
    });
    signal?.addEventListener('abort', cancelled, { once: true });
    if (signal?.aborted) { cancelled(); return; }
    timer = setTimeout(cancelled, Number.isFinite(timeoutMs) ? Math.max(1, Math.min(timeoutMs, 120000)) : LOCAL_WECHAT_HELPER_TIMEOUT);
    try { child.stdin.end(mode === 'status' ? '' : JSON.stringify(request)); }
    catch { finish(unknown(), true); }
    }).catch(() => finish(localWechatFailure('WECHAT_LOCAL_HELPER_UNAVAILABLE', request)));
  });
}
