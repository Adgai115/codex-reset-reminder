import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const directory = mkdtempSync(join(tmpdir(), 'codex-card-action-test-'));
process.env.CODEX_RESET_MONITOR_DATA_DIR = directory;
const { addManualCard, getCard, getFeishuMessage, getSnooze, markCardUsed, openStore,
  recordFeishuMessage, reportCardUsed, saveCodexSnapshot } = await import('./store.mjs');
const { handleCardAction } = await import('./card-actions.mjs');
const { buildFeishuCard } = await import('./feishu.mjs');
const config = { feishu: { userId: 'ou_owner' } };
const expiry = Math.floor(Date.now() / 1000) + 10 * 86400;
const card = (id) => ({ id, status: 'available', title: id, expiresAt: expiry });

function reset(cards = [card('credit-a')]) {
  const db = openStore();
  try {
    db.exec('DELETE FROM card_action_events; DELETE FROM feishu_messages; DELETE FROM snoozes; DELETE FROM reminder_deliveries; DELETE FROM sync_history; DELETE FROM cards;');
    saveCodexSnapshot(db, { availableCount: cards.length, credits: cards });
    for (const item of cards) recordFeishuMessage(db, { messageId: `om_${item.id}`,
      cardId: item.id, expiresAt: expiry, thresholdDays: 7, recipientOpenId: 'ou_owner' });
  } finally { db.close(); }
}

function event(eventId, action, messageId = 'om_credit-a', option = null, operator = 'ou_owner') {
  return { type: 'card.action.trigger', action_tag: 'button', event_id: eventId,
    message_id: messageId, operator_id: operator, token: 'fake-update-token',
    action_value: JSON.stringify({ action, ...(option ? { option } : {}) }) };
}

test('only the mapped recipient can choose a snooze; expiry stays unchanged', async () => {
  reset();
  const states = [];
  const handlers = { update: async (_config, _token, _card, _days, state) => states.push(state) };
  assert.equal(await handleCardAction(event('wrong', 'use', 'om_credit-a', null, 'ou_other'),
    config, handlers), 'unauthorized');
  assert.equal(await handleCardAction(event('choose', 'later'), config, handlers), 'choosing');
  assert.equal(await handleCardAction(event('snooze', 'snooze', 'om_credit-a', '1d'),
    config, handlers), 'snoozed:1d');
  const db = openStore();
  try {
    assert.equal(getCard(db, 'credit-a').expiresAt, expiry);
    assert.equal(getCard(db, 'credit-a').status, 'available');
    assert.equal(getFeishuMessage(db, 'om_credit-a').actionStatus, 'snoozed');
    const target = getSnooze(db, 'credit-a').targetAt;
    assert.ok(Math.abs(target - Math.floor(Date.now() / 1000) - 86400) < 5);
  } finally { db.close(); }
  assert.deepEqual(states, ['choosing', 'snoozed']);
});

test('a historical use button only records feedback; matching count drop confirms it', async () => {
  reset([card('credit-a'), card('credit-b')]);
  let refreshCalls = 0;
  const handlers = { refreshStatus: async () => { refreshCalls++; throw new Error('unexpected read'); },
    update: async () => ({}) };
  assert.equal(await handleCardAction(event('old-use', 'use', 'om_credit-b'),
    config, handlers), 'pending_verification');
  const db = openStore();
  try {
    assert.equal(getCard(db, 'credit-b').status, 'available');
    assert.ok(getCard(db, 'credit-b').reportedUsedAt);
    assert.equal(getCard(db, 'credit-b').reportedBaselineCount, 2);
    assert.equal(getFeishuMessage(db, 'om_credit-b').actionStatus, 'pending_verification');
    const result = saveCodexSnapshot(db, { availableCount: 1, credits: [card('credit-a')] });
    assert.equal(result.countDelta, -1);
    assert.deepEqual(result.newlyUsed, ['credit-b']);
    assert.equal(getCard(db, 'credit-b').status, 'used');
  } finally { db.close(); }
  assert.equal(refreshCalls, 0);
});

test('a new official card requires a confirmed consume action before using Codex', async () => {
  reset();
  const built = buildFeishuCard({ ...card('credit-a'), source: 'codex' }, 7);
  const primary = built.body.elements.find((item) => item.tag === 'column_set' && item.columns?.[0]?.elements?.[0]?.tag === 'button')
    ?.columns[0].elements[0];
  assert.equal(primary.text.content, '立即使用');
  assert.deepEqual(primary.behaviors[0].value, { action: 'consume' });
  assert.match(primary.confirm.text.content, /正式用卡请求/);
  let calls = 0;
  const states = [];
  const result = await handleCardAction(event('consume-once', 'consume'), config, {
    consume: async (id, key) => {
      calls++;
      assert.equal(id, 'credit-a');
      assert.match(key, /^[0-9a-f-]{36}$/);
      const db = openStore();
      try { markCardUsed(db, id); } finally { db.close(); }
      return { outcome: 'reset', statusInfo: { checkedAt: 123, remaining: 0 } };
    },
    update: async (_config, _token, _card, _days, state) => states.push(state),
  });
  assert.equal(result, 'used_codex:reset');
  assert.equal(calls, 1);
  assert.deepEqual(states, ['used']);
  const db = openStore();
  try { assert.equal(getCard(db, 'credit-a').status, 'used'); }
  finally { db.close(); }
  assert.equal(await handleCardAction(event('second-click', 'consume'), config, {
    consume: async () => { calls++; throw new Error('unexpected second use'); },
    update: async () => ({}),
  }), 'already_used');
  assert.equal(calls, 1);
});

test('a different Feishu user cannot directly use a card', async () => {
  reset();
  let calls = 0;
  assert.equal(await handleCardAction(event('foreign-consume', 'consume', 'om_credit-a', null, 'ou_other'),
    config, { consume: async () => { calls++; }, update: async () => ({}) }), 'unauthorized');
  assert.equal(calls, 0);
});

test('Codex can decline direct use without consuming the card', async () => {
  reset();
  const states = [];
  assert.equal(await handleCardAction(event('nothing-to-reset', 'consume'), config, {
    consume: async () => ({ outcome: 'nothingToReset' }),
    update: async (_config, _token, _card, _days, state) => states.push(state),
  }), 'nothingToReset');
  const db = openStore();
  try { assert.equal(getCard(db, 'credit-a').status, 'available'); }
  finally { db.close(); }
  assert.deepEqual(states, ['available']);
});

test('an uncertain direct use is verified later instead of pretending it succeeded', async () => {
  reset();
  const states = [];
  assert.equal(await handleCardAction(event('consume-timeout', 'consume'), config, {
    consume: async () => { throw new Error('timeout'); },
    update: async (_config, _token, _card, _days, state) => states.push(state),
  }), 'consume_uncertain');
  const db = openStore();
  try {
    assert.equal(getCard(db, 'credit-a').status, 'available');
    assert.ok(getCard(db, 'credit-a').reportedUsedAt);
  } finally { db.close(); }
  assert.deepEqual(states, ['pending_verification']);
});

test('a different card disappearing does not confirm the reported card', async () => {
  reset([card('credit-a'), card('credit-b')]);
  await handleCardAction(event('reported', 'use'), config, { update: async () => ({}) });
  const db = openStore();
  try {
    saveCodexSnapshot(db, { availableCount: 1, credits: [card('credit-a')] });
    assert.equal(getCard(db, 'credit-a').status, 'available');
    assert.ok(getCard(db, 'credit-a').reportedUsedAt);
    saveCodexSnapshot(db, { availableCount: 0, credits: [] });
    assert.equal(getCard(db, 'credit-a').status, 'used');
  } finally { db.close(); }
});

test('expiry itself cannot be mistaken for confirmed use', () => {
  reset([]);
  const expiresAt = Math.floor(Date.now() / 1000) + 3600;
  const db = openStore();
  try {
    saveCodexSnapshot(db, { availableCount: 1, credits: [
      { id: 'expiring-credit', status: 'available', title: '将到期', expiresAt },
    ] });
    const reported = db.prepare('SELECT id FROM cards WHERE id = ?').get('expiring-credit');
    assert.ok(reported);
    // The user may have reported use, but a later count drop caused only by expiry is inconclusive.
    reportCardUsed(db, 'expiring-credit');
    saveCodexSnapshot(db, { availableCount: 0, credits: [] }, expiresAt + 1);
    assert.equal(getCard(db, 'expiring-credit').status, 'not_available');
  } finally { db.close(); }
});

test('refresh checks Codex without consuming and can patch an expired callback token', async () => {
  reset();
  await handleCardAction(event('report', 'use'), config, { update: async () => ({}) });
  let patched = null;
  const result = await handleCardAction(event('refresh', 'refresh'), config, {
    refreshStatus: async () => {
      const db = openStore();
      try { saveCodexSnapshot(db, { availableCount: 0, credits: [] }); }
      finally { db.close(); }
      return { checkedAt: 123, remaining: 0 };
    },
    update: async () => { throw new Error('callback token expired'); },
    patch: async (_config, messageId, _card, _days, state) => { patched = { messageId, state }; },
  });
  assert.equal(result, 'confirmed_used');
  assert.deepEqual(patched, { messageId: 'om_credit-a', state: 'used' });
});

test('manual card use only changes local state', async () => {
  reset([]);
  const db = openStore();
  let id;
  try {
    id = addManualCard(db, { title: '手动测试卡', expiresAt: expiry });
    recordFeishuMessage(db, { messageId: 'om_manual', cardId: id, expiresAt: expiry,
      thresholdDays: 7, recipientOpenId: 'ou_owner' });
  } finally { db.close(); }
  assert.equal(await handleCardAction(event('manual-consume', 'consume', 'om_manual'), config,
    { consume: async () => { throw new Error('manual card must not call Codex'); },
      update: async () => ({}) }), 'ignored');
  assert.equal(await handleCardAction(event('manual-use', 'use', 'om_manual'), config,
    { update: async () => ({}) }), 'used_local');
  const check = openStore();
  try { assert.equal(getCard(check, id).status, 'used'); }
  finally { check.close(); }
});

test('a missing message mapping can be recovered from the clicked card', async () => {
  reset();
  const recovered = { ...event('recover', 'later', 'om_missing'),
    card_content: '7\n天后到期\n卡片编号\ncredit-a' };
  assert.equal(await handleCardAction(recovered, config, { update: async () => ({}) }), 'choosing');
  const db = openStore();
  try { assert.equal(getFeishuMessage(db, 'om_missing').cardId, 'credit-a'); }
  finally { db.close(); }
});

process.on('exit', () => rmSync(directory, { recursive: true, force: true }));
