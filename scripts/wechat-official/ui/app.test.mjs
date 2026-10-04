import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

// A small DOM harness exercises the actual renderer without Electron or a real
// WeChat connection. Elements expose only the APIs used by the validation UI.
class Element {
  constructor() { this.children = []; this.dataset = {}; this.value = ''; this.attributes = new Map(); this.ownText = ''; }
  set textContent(value) { this.ownText = String(value); this.children = []; }
  get textContent() { return this.ownText + this.children.map(child => child.textContent).join(''); }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.ownText = ''; this.children = children; }
  addEventListener() {}
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  setAttribute(name, value) { this.attributes.set(name, value); }
  removeAttribute(name) { this.attributes.delete(name); }
}

async function renderRecords(tests) {
  const nodes = new Map();
  let emit;
  const api = { onStatus(handler) { emit = handler; return () => {}; }, status: async () => ({ ok: true }) };
  const document = {
    getElementById(id) { if (!nodes.has(id)) nodes.set(id, new Element()); return nodes.get(id); },
    createElement: () => new Element(), createDocumentFragment: () => new Element(),
  };
  const source = await readFile(new URL('./app.mjs', import.meta.url), 'utf8');
  runInNewContext(source, { window: { wechatProbe: api, addEventListener() {} }, document }, { timeout: 1000 });
  emit({ phase: 'bound', busy: false, bound: true, hasContext: false, contextAt: null,
    scheduled: null, listening: true, tests });
  await Promise.resolve();
  const root = nodes.get('tests');
  const metadata = [];
  function walk(node) {
    if (node.className === 'test-meta') metadata.push(node.textContent);
    node.children.forEach(walk);
  }
  walk(root);
  return { metadata, text: root.textContent };
}

const record = { id: 'synthetic-test-id', label: '即时测试', at: '2026-10-02T08:00:00Z',
  confirmation: 'rejected', code: 'WECHAT_REJECTED' };

test('rejected test UI shows bounded numeric diagnostics while retaining the existing error category', async () => {
  const result = await renderRecords([
    { ...record, businessCode: -7, httpStatus: 403 },
    { ...record, businessCode: -2147483648, httpStatus: 100 },
    { ...record, businessCode: 2147483647, httpStatus: 599 },
    record,
  ]);
  assert.ok(result.metadata[0].includes('错误码 WECHAT_REJECTED'));
  assert.ok(result.metadata[0].includes('业务码 -7'));
  assert.ok(result.metadata[0].includes('HTTP 403'));
  assert.ok(result.metadata[1].includes('业务码 -2147483648'));
  assert.ok(result.metadata[2].includes('业务码 2147483647'));
  assert.ok(result.metadata[3].includes('错误码 WECHAT_REJECTED'));
  assert.ok(!result.metadata[3].includes('业务码'));
});

test('UI drops malformed diagnostics and shows no rejected diagnostic label on unknown or received records', async () => {
  const result = await renderRecords([
    { ...record, code: 'synthetic-private-code', businessCode: 'synthetic-private-business', httpStatus: 'synthetic-private-http' },
    { ...record, businessCode: 2147483648, httpStatus: 600 },
    { ...record, businessCode: -2147483649, httpStatus: 99 },
    { ...record, businessCode: 1.5, httpStatus: 403.5 },
    { ...record, businessCode: NaN, httpStatus: Infinity },
    { ...record, confirmation: 'unknown', code: 'WECHAT_UNKNOWN', businessCode: -7, httpStatus: 502,
      responseRet: 0, responseErrcode: -7 },
    { ...record, confirmation: 'received', businessCode: -7, httpStatus: 403 },
  ]);
  assert.ok(!result.text.includes('synthetic-private'));
  for (const metadata of result.metadata) {
    assert.ok(!metadata.includes('业务码'));
    assert.ok(!metadata.includes('HTTP'));
  }
  assert.ok(result.text.includes('发送结果待确认'));
  assert.ok(result.text.includes('手机已收到'));
  assert.ok(result.text.includes('已收到'));
});
