import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { callFeishuCli } from './feishu.mjs';
import { larkCommand } from './native-bin.mjs';

test('lark-cli script can run with Node when no native launcher is installed', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codex-reset-lark-'));
  try {
    const script = join(directory, 'scripts', 'run.js');
    await mkdir(dirname(script), { recursive: true });
    await writeFile(script, 'console.log(JSON.stringify({ok:true,data:{message_id:"om_test"}}))\n');
    const config = { larkCliScript: script, nodePath: process.execPath };
    const command = larkCommand(config);
    assert.equal(command.executable, process.execPath);
    assert.deepEqual(command.prefix, [script]);
    const result = await callFeishuCli(config, ['im', '+messages-send', '--json']);
    assert.equal(result.data.message_id, 'om_test');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
