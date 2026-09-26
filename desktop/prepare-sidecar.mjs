import { copyFile, chmod, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

if (Number(process.versions.node.split('.')[0]) !== 24) {
  throw new Error('打包 sidecar 需要 Node.js 24');
}
const target = join(dirname(fileURLToPath(import.meta.url)), '..', 'vendor-node',
  process.platform === 'win32' ? 'node.exe' : 'node');
await mkdir(dirname(target), { recursive: true });
await copyFile(process.execPath, target);
if (process.platform !== 'win32') await chmod(target, 0o755);
console.log(`已准备 Node ${process.version} sidecar`);
