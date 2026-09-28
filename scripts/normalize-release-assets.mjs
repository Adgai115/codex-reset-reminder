// GitHub Release 会把附件名中的空格替换为句点；校验清单必须使用下载后的文件名。
import { readdir, rename } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const directory = resolve(process.argv[2] || 'artifacts');
const entries = (await readdir(directory, { withFileTypes: true }))
  .filter((entry) => entry.isFile());
if (entries.length === 0) throw new Error('没有可发布的安装包');

const names = new Set();
for (const entry of entries) {
  const name = entry.name.replaceAll(' ', '.');
  if (names.has(name)) throw new Error(`附件名称冲突：${name}`);
  names.add(name);
}

for (const entry of entries) {
  const name = entry.name.replaceAll(' ', '.');
  if (name !== entry.name) await rename(join(directory, entry.name), join(directory, name));
}
console.log(`已核对 ${entries.length} 个附件文件名`);
