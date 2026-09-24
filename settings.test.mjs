import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { mergeSettings, saveSettings, viewSettings } from './settings.mjs';

const base = {
  codexScript: 'keep-this-account',
  feishu: { enabled: true, as: 'bot', userId: 'ou_configured', profile: 'keep-this-profile' },
  wechat: { enabled: false, templateId: 'keep-disabled-channel' },
  otherFutureSetting: { keep: true },
};
const values = {
  desktopEnabled: false, feishuEnabled: false, quietEnabled: true,
  quietStart: '23:00', quietEnd: '08:30', preflightEnabled: false, retryMinutes: 120,
};

test('visual settings preserve credentials, unknown fields, and disabled channels', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'codex-settings-test-'));
  try {
    const path = join(directory, 'config.json');
    writeFileSync(path, JSON.stringify(base));
    const saved = await saveSettings(values, path);
    assert.equal(saved.desktopEnabled, false);
    assert.equal(saved.feishuEnabled, false);
    const config = JSON.parse(readFileSync(path, 'utf8'));
    assert.equal(config.codexScript, 'keep-this-account');
    assert.equal(config.feishu.userId, 'ou_configured');
    assert.equal(config.feishu.profile, 'keep-this-profile');
    assert.deepEqual(config.wechat, base.wechat);
    assert.deepEqual(config.otherFutureSetting, base.otherFutureSetting);
    assert.equal(config.reminders.quietHours.start, '23:00');
    assert.equal(config.reminders.preflightSync.retryMinutes, 120);
    assert.deepEqual(viewSettings(config), { ...values, feishuConfigured: true });
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('invalid settings cannot enable an unconfigured Feishu channel', () => {
  assert.throws(() => mergeSettings({ feishu: {} }, { ...values, feishuEnabled: true }),
    /请先配置飞书机器人/);
  assert.throws(() => mergeSettings(base, { ...values, quietStart: '25:00' }),
    /HH:mm/);
  assert.throws(() => mergeSettings(base, { ...values, quietEnd: '23:00' }),
    /不能相同/);
});
