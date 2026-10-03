import { app, safeStorage } from 'electron';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { localWechatFailure } from '../core/wechat-local-http.mjs';
import { parseLocalWechatHelperArguments, readLocalWechatInput, runLocalWechatClient } from './wechat-local-client-runtime.mjs';
import { takeLocalClientBridge, readLocalClientBridge, returnLocalClientBridge } from '../core/wechat-local-bridge.mjs';
import { prepareLocalWechatClientProfile } from './wechat-local-export.mjs';

// Keep the same OS keychain identity as the experimental authorization tool.
// A separate temporary Electron profile avoids touching the official app profile
// and permits helpers alongside the one gateway process. No browser is opened.
app.setName('Codex 微信直连验证');
const temporaryRoot = resolve(tmpdir());
const profile = mkdtempSync(join(temporaryRoot, 'codex-wechat-local-client-'));
app.setPath('userData', profile);
app.disableHardwareAcceleration();
let result;
let bridge;
try { bridge = takeLocalClientBridge(process.env); } catch {}
let options;
try {
  const marker = process.argv.indexOf('--wechat-local-client-helper');
  options = parseLocalWechatHelperArguments(marker >= 0 ? process.argv.slice(marker + 1) : process.argv.slice(2));
  await prepareLocalWechatClientProfile(options.clientFile, profile);
} catch { options = null; }
app.whenReady().then(async () => {
try {
  if (!options) throw new Error('LOCAL_CLIENT_INVALID');
  const input = bridge ? await readLocalClientBridge(bridge) : null;
  if (input && input.mode !== options.mode) throw new Error('LOCAL_BRIDGE_INVALID');
  const request = input ? input.request : options.mode === 'notify' ? await readLocalWechatInput(process.stdin) : undefined;
  result = await runLocalWechatClient({ ...options, request, crypto: safeStorage });
} catch {
  result = localWechatFailure('WECHAT_LOCAL_CONFIGURATION');
}
if (bridge) await returnLocalClientBridge(bridge, result).catch(() => {});
function finish() {
  // The generated path is checked against its explicit temporary root before
  // recursive cleanup. No caller-supplied profile or real app path is removed.
  if (resolve(profile).startsWith(temporaryRoot + sep)
    && profile.startsWith(join(temporaryRoot, 'codex-wechat-local-client-'))) {
    try { rmSync(profile, { recursive: true, force: true }); } catch { /* Native handles may still be closing. */ }
  }
  app.exit(['accepted', 'status'].includes(result.state) ? 0 : result.state === 'unknown' || result.state === 'pending' ? 2 : 1);
}
if (bridge) finish(); else process.stdout.write(`${JSON.stringify(result)}\n`, finish);
});
