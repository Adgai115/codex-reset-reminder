import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { version } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
assert.equal(process.env.GITHUB_REF_NAME, `v${version}`,
  `发布 tag 必须与 package.json 版本一致：v${version}`);
console.log(`发布版本已核对：v${version}`);
