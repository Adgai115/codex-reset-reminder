import assert from 'node:assert/strict';
import test from 'node:test';
import { checkForUpdates, compareVersions, releasePageFor } from './update-check.mjs';

test('version order handles prereleases and stable versions', () => {
  assert.ok(compareVersions('v2.0.0-beta.2', '2.0.0-beta.1') > 0);
  assert.ok(compareVersions('2.0.0', '2.0.0-rc.3') > 0);
  assert.ok(compareVersions('2.0.1', '2.0.0') > 0);
});

test('update check includes prereleases and only opens a fixed repository URL', async () => {
  const fetcher = async () => ({ ok: true, json: async () => [
    { tag_name: 'v2.0.0-beta.2', draft: false },
    { tag_name: 'v2.0.0-beta.3', draft: true },
    { tag_name: 'v1.9.0', draft: false },
  ] });
  const result = await checkForUpdates('2.0.0-beta.1', { fetcher });
  assert.equal(result.state, 'available');
  assert.equal(result.latestVersion, 'v2.0.0-beta.2');
  assert.equal(releasePageFor(result.latestVersion),
    'https://github.com/Adgai115/codex-reset-reminder/releases/tag/v2.0.0-beta.2');
  assert.throws(() => releasePageFor('https://other.example'));
});

test('正式版用户不会被提示安装测试版，领先公开版本时说明实际版本', async () => {
  const fetcher = async () => ({ ok: true, json: async () => [
    { tag_name: 'v3.0.0-beta.1', prerelease: true }, { tag_name: 'v2.0.0' },
  ] });
  const result = await checkForUpdates('2.0.0', { fetcher });
  assert.equal(result.state, 'current');
  assert.equal(result.latestVersion, 'v2.0.0');
  const ahead = await checkForUpdates('2.0.1', { fetcher });
  assert.match(ahead.message, /最新公开版本为 v2.0.0/);
});
