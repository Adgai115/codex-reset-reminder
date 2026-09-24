import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const executable = join(root, 'node_modules', 'electron', 'dist',
  process.platform === 'win32' ? 'electron.exe' : 'electron');
const result = spawnSync(executable, [join(root, 'desktop', 'sqlite-probe.mjs')], {
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', timeout: 20000,
});
if (result.status !== 0 || !result.stdout.includes('SQLITE_OK')) {
  throw new Error(`Electron node:sqlite 探针失败：${result.stderr || result.error?.message || result.stdout}`);
}
console.log(result.stdout.trim());
