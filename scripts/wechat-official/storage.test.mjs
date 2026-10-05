import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProbeStorage } from './storage.mjs';

const crypto = { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'test_backend',
  encryptString: value => Buffer.from(value, 'utf8').map(byte => byte ^ 0x57),
  decryptString: value => Buffer.from(value).map(byte => byte ^ 0x57).toString('utf8') };
test('isolated storage encrypts credentials and writes only allowlisted receipt metadata', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wechat-storage-'));
  try {
    const store = createProbeStorage(directory, crypto);
    const data = { version: 1, session: { token: 'synthetic-secret-never-real' }, contextToken: 'private-context' };
    await store.write(data);
    assert.deepEqual(await store.read(), data);
    assert.ok(!(await readFile(join(directory, 'session.bin'))).includes(Buffer.from(data.session.token)));
    await store.writeStatus({ phase: 'login', qrDataUrl: 'private-qr', token: 'private-token', contextToken: 'private-context',
      scheduled: null, tests: [{ id: 'mock-test', label: '即时测试', at: '2026-10-02T08:00:00Z', confirmation: 'accepted', rawMessage: 'private-text' }] });
    const plain = await readFile(join(directory, 'status.json'), 'utf8');
    assert.ok(plain.includes('accepted'));
    for (const value of ['private-qr', 'private-token', 'private-context', 'private-text']) assert.ok(!plain.includes(value));
    assert.deepEqual((await readdir(directory)).sort(), ['session.bin', 'status.json']);
    await store.remove(); assert.equal(await store.read(), null);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('storage refuses unavailable or plaintext system credential encryption', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wechat-storage-'));
  try {
    for (const backend of [{ ...crypto, isEncryptionAvailable: () => false }, { ...crypto, getSelectedStorageBackend: () => 'basic_text' }]) {
      const store = createProbeStorage(directory, backend);
      await assert.rejects(store.write({ version: 1 }), /加密/);
      assert.deepEqual(await readdir(directory), []);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('public receipt diagnostics allow only signed 32-bit business codes and valid numeric HTTP statuses', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wechat-storage-'));
  try {
    const store = createProbeStorage(directory, crypto);
    const legacy = { id: 'legacy-test', label: '即时测试', at: '2026-10-02T08:00:00Z',
      confirmation: 'received', code: 'WECHAT_UNKNOWN', contextAgeMinutes: 5 };
    const valid = [[-2147483648, 100], [-7, 403], [0, 200], [2147483647, 599]];
    const invalid = [['synthetic-secret-code', 'synthetic-secret-status'], ['-7', '403'], [true, false], [null, null],
      [1.25, 403.25], [NaN, Infinity], [-2147483649, 99], [2147483648, 600]];
    await store.writeStatus({ phase: 'bound', busy: false, bound: true, hasContext: false, contextAt: null,
      listening: false, scheduled: null, tests: [legacy,
        ...valid.map(([businessCode, httpStatus], index) => ({ ...legacy, id: `valid-${index}`, businessCode, httpStatus,
          responseRet: businessCode, responseErrcode: businessCode,
          responseHint: ['absent', 'empty', 'prepare_failed', 'rate_limited'][index], contextMode: index % 2 ? 'included' : 'omitted' })),
        ...invalid.map(([businessCode, httpStatus], index) => ({ ...legacy, id: `invalid-${index}`, businessCode, httpStatus,
          responseRet: businessCode, responseErrcode: businessCode,
          responseHint: 'synthetic-private-hint', contextMode: 'synthetic-private-mode',
          errmsg: 'synthetic-private-message', rawResponse: 'synthetic-private-response', token: 'synthetic-private-token', body: 'synthetic-private-body' })),
        { ...legacy, id: 'private-code', code: 'synthetic-private-code' },
      ] });
    const plain = await readFile(join(directory, 'status.json'), 'utf8');
    const records = JSON.parse(plain).tests;
    assert.deepEqual(records[0], legacy);
    valid.forEach(([businessCode, httpStatus], index) => {
      assert.equal(records[index + 1].businessCode, businessCode);
      assert.equal(records[index + 1].httpStatus, httpStatus);
      assert.equal(records[index + 1].responseRet, businessCode);
      assert.equal(records[index + 1].responseErrcode, businessCode);
      assert.equal(records[index + 1].responseHint, ['absent', 'empty', 'prepare_failed', 'rate_limited'][index]);
      assert.equal(records[index + 1].contextMode, index % 2 ? 'included' : 'omitted');
    });
    for (const record of records.slice(valid.length + 1)) {
      assert.equal(Object.hasOwn(record, 'businessCode'), false);
      assert.equal(Object.hasOwn(record, 'httpStatus'), false);
      assert.equal(Object.hasOwn(record, 'responseRet'), false);
      assert.equal(Object.hasOwn(record, 'responseErrcode'), false);
      assert.equal(Object.hasOwn(record, 'responseHint'), false);
      assert.equal(Object.hasOwn(record, 'contextMode'), false);
    }
    assert.equal(Object.hasOwn(records.at(-1), 'code'), false);
    assert.ok(!plain.includes('synthetic-secret'));
    assert.ok(!plain.includes('synthetic-private'));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('public polling status has bounded counts, fixed diagnostics and a distinct waiting state', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wechat-storage-'));
  const at = '2026-10-05T02:00:00.000Z';
  const cases = [
    [{ state: 'ok', at, messageCount: 1000, pairedCount: 1, contextCount: 0 },
      { state: 'ok', at, messageCount: 1000, pairedCount: 1, contextCount: 0 }],
    [{ state: 'ok', at, messageCount: 1001, pairedCount: -1, contextCount: 'synthetic-private-count' }, { state: 'ok', at }],
    [{ state: 'error', at, code: 'WECHAT_REJECTED', businessCode: -7, responseRet: -7, responseErrcode: 0,
      httpStatus: 403, responseHint: 'other', errmsg: 'synthetic-private-message', token: 'synthetic-private-token', body: 'synthetic-private-body' },
      { state: 'error', at, code: 'WECHAT_REJECTED', businessCode: -7, responseRet: -7, responseErrcode: 0, httpStatus: 403, responseHint: 'other' }],
    [{ state: 'error', at, code: 'synthetic-private-code', responseHint: 'synthetic-private-hint',
      businessCode: 'synthetic-private-code', responseRet: Infinity, responseErrcode: 2147483648, httpStatus: 600 }, { state: 'error', at }],
    [{ state: 'waiting', at, messageCount: 0, pairedCount: 0, contextCount: 0, code: 'WECHAT_TIMEOUT', responseHint: 'other' }, { state: 'waiting', at }],
    [{ state: 'synthetic-private-state', at }, null],
    [{ state: 'ok', at: 'synthetic-private-time' }, null],
    [{ state: 'ok', at: '2026-02-30T02:00:00.000Z' }, null],
  ];
  try {
    const store = createProbeStorage(directory, crypto);
    for (const [lastPoll, expected] of cases) {
      await store.writeStatus({ phase: 'bound', tests: [], lastPoll });
      const plain = await readFile(join(directory, 'status.json'), 'utf8');
      assert.deepEqual(JSON.parse(plain).lastPoll, expected);
      assert.ok(!plain.includes('synthetic-private'));
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
