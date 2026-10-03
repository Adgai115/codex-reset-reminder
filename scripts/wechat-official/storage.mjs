import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

// This development profile never reads the reminder application's config or DB.
export function createProbeStorage(directory, crypto, { secretName = 'session.bin', statusName = 'status.json' } = {}) {
  if (![secretName, statusName].every((name) => typeof name === 'string' && /^[a-z0-9-]+\.(?:bin|json)$/.test(name)))
    throw new Error('本机存储文件名无效。');
  const secretPath = join(directory, secretName);
  const statusPath = join(directory, statusName);
  let writes = Promise.resolve();
  function requireEncryption() {
    if (!crypto?.isEncryptionAvailable?.()
      || crypto.getSelectedStorageBackend?.() === 'basic_text')
      throw new Error('系统凭据加密不可用，无法保存微信测试连接。');
  }
  async function atomicWrite(path, bytes) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, bytes, { mode: 0o600, flag: 'wx' });
      await rename(temporary, path);
    } finally { await rm(temporary, { force: true }).catch(() => {}); }
  }
  function enqueue(operation) {
    const result = writes.then(operation);
    writes = result.catch(() => {});
    return result;
  }
  return {
    async read() {
      let bytes;
      try { bytes = await readFile(secretPath); }
      catch (error) { if (error.code === 'ENOENT') return null; throw new Error('测试连接无法读取。'); }
      requireEncryption();
      try {
        const value = JSON.parse(crypto.decryptString(bytes));
        if (value?.version !== 1) throw new Error();
        return value;
      } catch { throw new Error('测试连接无法解密，请清除测试连接后重新扫码。'); }
    },
    write(value) {
      let encrypted;
      try { requireEncryption(); encrypted = crypto.encryptString(JSON.stringify(value)); }
      catch { return Promise.reject(new Error('测试连接无法加密保存。')); }
      return enqueue(() => atomicWrite(secretPath, encrypted));
    },
    writeStatus(status) {
      // Explicit allowlist: no QR, URL, user ID, token, cursor, or message text.
      const value = {
        phase: status.phase, busy: status.busy, bound: status.bound,
        hasContext: status.hasContext, contextAt: status.contextAt,
        listening: status.listening, scheduled: status.scheduled,
        tests: status.tests.map(({ id, label, at, confirmation, code, contextAgeMinutes }) =>
          ({ id, label, at, confirmation, ...(code ? { code } : {}),
            ...(typeof contextAgeMinutes === 'number' ? { contextAgeMinutes } : {}) })),
      };
      return enqueue(() => atomicWrite(statusPath, JSON.stringify(value, null, 2)));
    },
    remove() { return enqueue(() => rm(secretPath, { force: true })); },
  };
}
