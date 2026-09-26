import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { createCallbackListener } from './callback-listener.mjs';

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('Feishu listener reports a running process and received interaction', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codex-reset-listener-'));
  let listener;
  try {
    const script = join(directory, 'scripts', 'run.js');
    const configPath = join(directory, 'config.json');
    await mkdir(dirname(script), { recursive: true });
    await writeFile(script, 'console.log(JSON.stringify({event_id:"test"})); setInterval(() => {}, 1000);\n');
    await writeFile(configPath, JSON.stringify({ nodePath: process.execPath, larkCliScript: script,
      feishu: { enabled: true, as: 'bot', userId: 'ou_test', profile: 'test' } }));
    listener = createCallbackListener({ configPath, databasePath: join(directory, 'data.db'),
      coreRequest: async () => 'ignored', onChanged: async () => {} });
    await listener.start();
    for (let attempt = 0; attempt < 40 && !listener.status().lastEventAt; attempt++) await pause(50);
    assert.equal(listener.status().state, 'listening');
    assert.ok(listener.status().lastEventAt);
  } finally {
    if (listener) await listener.stop();
    await rm(directory, { recursive: true, force: true });
  }
});
