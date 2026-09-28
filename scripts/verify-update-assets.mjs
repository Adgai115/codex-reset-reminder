import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { resolve, join } from 'node:path';

const directory = resolve(process.argv[2] || 'dist');
const manifest = await readFile(join(directory, 'latest.yml'), 'utf8');
const version = /^version:\s*([^\s]+)\s*$/m.exec(manifest)?.[1];
const fileName = /^\s*- url:\s*([^\s]+)\s*$/m.exec(manifest)?.[1];
const expectedHash = /^\s+sha512:\s*([A-Za-z0-9+/=]+)\s*$/m.exec(manifest)?.[1];
assert.ok(version && fileName && expectedHash, 'Windows 更新元数据不完整');
assert.equal(fileName, `Codex.Reset.Reminder.Setup.${version}.exe`, '更新元数据与安装包名不一致');
const expectedVersion = process.env.GITHUB_REF_NAME?.replace(/^v/, '') ||
  JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version;
assert.equal(version, expectedVersion, '更新元数据版本与发布版本不一致');
const installerPath = join(directory, fileName);
assert.ok((await stat(installerPath)).size > 0, 'Windows 安装包为空');
const digest = createHash('sha512');
for await (const chunk of createReadStream(installerPath)) digest.update(chunk);
assert.equal(digest.digest('base64'), expectedHash, 'Windows 安装包与更新元数据校验值不一致');
console.log(`Windows 更新附件已核对：${fileName}`);
