import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { createWindowsUpdater } from './update-install.mjs';

class FakeUpdater extends EventEmitter {
  installed = 0;
  downloaded = 0;
  version = '2.0.3';
  async checkForUpdates() { return { updateInfo: { version: this.version } }; }
  async downloadUpdate() { this.downloaded++; this.emit('download-progress', { percent: 42.8 }); }
  quitAndInstall(silent, restart) {
    assert.equal(silent, true);
    assert.equal(restart, true);
    this.installed++;
  }
}

test('Windows upgrade requires check and verified download before explicit install', async () => {
  const fake = new FakeUpdater();
  const events = [];
  const flow = createWindowsUpdater({ updater: fake, currentVersion: '2.0.2', emit: (state) => events.push(state) });
  assert.equal(fake.autoDownload, false);
  assert.equal(fake.autoInstallOnAppQuit, false);
  assert.equal(fake.disableDifferentialDownload, true);
  assert.throws(() => flow.install('2.0.3'), /先完成下载/);
  const result = await flow.check();
  assert.equal(result.canInstall, true);
  await assert.rejects(flow.download('2.0.4'), /先检查/);
  await flow.download('2.0.3');
  assert.equal(fake.downloaded, 1);
  assert.ok(events.some((state) => state.phase === 'downloading' && state.percent === 42));
  assert.equal(fake.installed, 0);
  flow.install('2.0.3');
  assert.equal(fake.installed, 1);
});

test('download failure keeps the checked version available for retry', async () => {
  const fake = new FakeUpdater();
  fake.downloadUpdate = async () => { throw new Error('网络中断'); };
  const flow = createWindowsUpdater({ updater: fake, currentVersion: '2.0.2' });
  await flow.check();
  await assert.rejects(flow.download('2.0.3'), /网络中断/);
  assert.equal(flow.status().phase, 'available');
  assert.throws(() => flow.install('2.0.3'), /先完成下载/);
});

test('current or older releases never enter the install flow', async () => {
  const fake = new FakeUpdater();
  fake.version = '2.0.2';
  const flow = createWindowsUpdater({ updater: fake, currentVersion: '2.0.2' });
  assert.equal((await flow.check()).state, 'current');
  await assert.rejects(flow.download('2.0.2'), /先检查/);
  fake.version = '2.0.1';
  assert.equal((await flow.check()).state, 'current');
  assert.equal(fake.downloaded, 0);
});

test('rechecking a verified download keeps it installable, including while offline', async () => {
  const fake = new FakeUpdater();
  const flow = createWindowsUpdater({ updater: fake, currentVersion: '2.0.2' });
  await flow.check();
  await flow.download('2.0.3');
  assert.equal((await flow.check()).phase, 'ready');
  fake.checkForUpdates = async () => { throw new Error('模拟离线'); };
  assert.equal((await flow.check()).canInstall, true);
  assert.equal(flow.status().phase, 'ready');
  assert.equal(fake.downloaded, 1);
  flow.install('2.0.3');
  assert.equal(fake.installed, 1);
  await assert.rejects(flow.check(), /升级正在启动/);
});

test('a newer release requires its own verified download', async () => {
  const fake = new FakeUpdater();
  const flow = createWindowsUpdater({ updater: fake, currentVersion: '2.0.2' });
  await flow.check();
  await flow.download('2.0.3');
  fake.version = '2.0.4';
  await flow.check();
  assert.equal(flow.status().phase, 'available');
  assert.throws(() => flow.install('2.0.3'), /先完成下载/);
  assert.throws(() => flow.install('2.0.4'), /先完成下载/);
});

test('installer launch failures preserve the download and permit explicit retry', async () => {
  const fake = new FakeUpdater();
  const flow = createWindowsUpdater({ updater: fake, currentVersion: '2.0.2' });
  await flow.check();
  await flow.download('2.0.3');
  fake.quitAndInstall = () => { throw new Error('模拟启动失败'); };
  assert.throws(() => flow.install('2.0.3'), /模拟启动失败/);
  assert.equal(flow.status().phase, 'ready');
  fake.quitAndInstall = () => fake.emit('error', new Error('模拟安装错误'));
  assert.throws(() => flow.install('2.0.3'), /升级未开始/);
  assert.equal(flow.status().phase, 'ready');
  fake.quitAndInstall = () => fake.installed++;
  flow.install('2.0.3');
  fake.emit('error', new Error('模拟异步错误'));
  assert.equal(flow.status().phase, 'ready');
  assert.equal(fake.downloaded, 1);
  flow.install('2.0.3');
  assert.equal(fake.installed, 2);
});
