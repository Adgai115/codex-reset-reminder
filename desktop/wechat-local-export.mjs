import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readLimitedLocalFile } from '../core/wechat-local-http.mjs';

const envelopeKind = 'wechat-local-encrypted';
export function decodeLocalWechatBundle(bytes) {
  // Earlier developer exports were raw safeStorage blobs; accept them only
  // where the current OS keychain can actually decrypt them.
  if (bytes[0] !== 123) return { encrypted: bytes };
  const value = JSON.parse(bytes.toString('utf8'));
  if (value.version !== 1 || value.kind !== envelopeKind
    || typeof value.data !== 'string' || value.data.length > 32768 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value.data)) throw new Error('LOCAL_CLIENT_INVALID');
  if (value.windowsKey !== undefined && (typeof value.windowsKey !== 'string' || value.windowsKey.length > 8192
    || !/^[A-Za-z0-9+/]+={0,2}$/.test(value.windowsKey))) throw new Error('LOCAL_CLIENT_INVALID');
  return { encrypted: Buffer.from(value.data, 'base64'), windowsKey: value.windowsKey };
}

// OSCrypt on Windows uses a profile AES key protected by DPAPI. Include only
// that OS-encrypted key so an isolated helper can decrypt without sharing or
// modifying the gateway's running Chromium profile. Never export plaintext keys.
export async function exportLocalWechatClient(client, { crypto, userData, platform = process.platform }) {
  if (!crypto?.isEncryptionAvailable?.() || crypto.getSelectedStorageBackend?.() === 'basic_text') throw new Error('LOCAL_CLIENT_ENCRYPTION');
  const value = { version: 1, kind: envelopeKind, data: crypto.encryptString(JSON.stringify(client)).toString('base64') };
  if (platform === 'win32') {
    let windowsKey;
    // A new Chromium profile writes its DPAPI envelope asynchronously after
    // initial key generation. Wait briefly for that write, without changing it.
    for (let attempt = 0; attempt < 150; attempt++) {
      try {
        const state = JSON.parse((await readLimitedLocalFile(join(userData, 'Local State'), 1048576)).toString('utf8'));
        windowsKey = state.os_crypt?.encrypted_key;
        if (typeof windowsKey === 'string') break;
      } catch { /* No OS key or full Local State is returned to the caller. */ }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (typeof windowsKey !== 'string' || windowsKey.length > 8192 || !/^[A-Za-z0-9+/]+={0,2}$/.test(windowsKey)
      || Buffer.from(windowsKey, 'base64').subarray(0, 5).toString() !== 'DPAPI') throw new Error('LOCAL_CLIENT_ENCRYPTION');
    value.windowsKey = windowsKey;
  }
  return Buffer.from(JSON.stringify(value));
}

export async function prepareLocalWechatClientProfile(clientFile, profile, { platform = process.platform } = {}) {
  const bundle = decodeLocalWechatBundle(await readLimitedLocalFile(clientFile, 65536));
  if (platform === 'win32' && bundle.windowsKey) {
    if (Buffer.from(bundle.windowsKey, 'base64').subarray(0, 5).toString() !== 'DPAPI') throw new Error('LOCAL_CLIENT_ENCRYPTION');
    await writeFile(join(profile, 'Local State'), JSON.stringify({ os_crypt: { encrypted_key: bundle.windowsKey } }), { mode: 0o600, flag: 'wx' });
  }
}
