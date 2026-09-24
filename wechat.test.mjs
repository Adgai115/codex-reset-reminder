import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const directory = mkdtempSync(join(tmpdir(), 'codex-wechat-test-'));
process.env.CODEX_RESET_MONITOR_DATA_DIR = directory;
const { addManualCard, deliveryExists, getSnooze, openStore, scheduleSnooze } = await import('./store.mjs');
const { planNextCheck } = await import('./plan-next.mjs');
const { runReminders } = await import('./remind.mjs');
const { buildWechatTemplate } = await import('./wechat.mjs');

const configPath = join(directory, 'config.json');
const config = { feishu: { enabled: false }, wechat: { enabled: true, openId: 'receiver',
  templateId: 'selected-template', fieldMap: { thing1: 'cardName', time2: 'expiresAt', number3: 'remainingDays' } } };
writeFileSync(configPath, JSON.stringify(config));

test('WeChat template uses configured fields and never includes credentials', () => {
  const card = { id: 'card-id', title: 'Full reset', expiresAt: 1791000000 };
  const payload = buildWechatTemplate(config, card, 3, { currentAvailableCount: 2 });
  assert.deepEqual(Object.keys(payload.data), ['thing1', 'time2', 'number3']);
  assert.equal(payload.data.thing1.value, 'Full reset');
  assert.equal(payload.data.number3.value, '3');
  assert.equal(JSON.stringify(payload).includes('appSecret'), false);
});

test('WeChat reminder deduplicates fixed and snoozed sends alongside desktop', async () => {
  const now = Math.floor(Date.now() / 1000);
  const expiry = now + 7 * 86400;
  const db = openStore();
  let id;
  try { id = addManualCard(db, { title: '到期卡', expiresAt: expiry }); }
  finally { db.close(); }
  const calls = [];
  const handlers = { configPath, desktop: async () => calls.push('desktop'),
    wechat: async () => { calls.push('wechat'); return { ok: true }; } };
  await runReminders({ ...handlers, nowSeconds: now });
  await runReminders({ ...handlers, nowSeconds: now });
  assert.deepEqual(calls, ['wechat', 'desktop']);
  const after = openStore();
  try {
    assert.equal(deliveryExists(after, id, expiry, 7, 'wechat'), true);
    assert.equal(planNextCheck(after, { wechatEnabled: true, nowSeconds: now }).nextAt, expiry - 3 * 86400);
    scheduleSnooze(after, id, expiry, now + 86400);
    assert.equal(planNextCheck(after, { wechatEnabled: true, nowSeconds: now }).nextAt, now + 86400);
  } finally { after.close(); }
  await runReminders({ ...handlers, nowSeconds: now + 86400 });
  await runReminders({ ...handlers, nowSeconds: now + 86400 });
  assert.deepEqual(calls, ['wechat', 'desktop', 'wechat', 'desktop']);
  const check = openStore();
  try { assert.ok(getSnooze(check, id).wechatDeliveredAt); }
  finally { check.close(); }
});

process.on('exit', () => rmSync(directory, { recursive: true, force: true }));
