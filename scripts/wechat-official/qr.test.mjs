import test from 'node:test';
import assert from 'node:assert/strict';
import { renderQrDataUrl } from './qr.mjs';

const syntheticUrl = 'https://ilinkai.weixin.qq.com/mock?code=synthetic-qr-only';

test('QR can be shown as a local image with a square shape and four-module quiet zone', () => {
  const dataUrl = renderQrDataUrl(syntheticUrl);
  assert.match(dataUrl, /^data:image\/svg\+xml;base64,[A-Za-z0-9+/]+=*$/u);
  const svg = Buffer.from(dataUrl.split(',')[1], 'base64').toString('utf8');
  const bounds = svg.match(/viewBox="0 0 (\d+) (\d+)"/u);
  assert.ok(bounds);
  const width = Number(bounds[1]);
  assert.equal(width, Number(bounds[2]));
  const moduleCount = width - 8;
  assert.ok(moduleCount >= 21 && moduleCount <= 177);
  assert.equal((moduleCount - 21) % 4, 0);
  const cells = [...svg.matchAll(/M(\d+) (\d+)h1v1h-1z/gu)];
  assert.ok(cells.length > 0);
  for (const cell of cells) {
    const x = Number(cell[1]);
    const y = Number(cell[2]);
    assert.ok(x >= 4 && y >= 4 && x < width - 4 && y < width - 4);
  }
  assert.ok(!svg.includes(syntheticUrl));
  assert.ok(!svg.includes('<script'));
  assert.ok(!svg.includes('href='));
});

test('different mock URLs produce different QR images', () => {
  assert.notEqual(renderQrDataUrl(syntheticUrl), renderQrDataUrl(`${syntheticUrl}-2`));
});

test('QR rejects oversized or non-ASCII inputs without including the input in errors', () => {
  for (const value of ['', 'x'.repeat(1025), 'https://example.invalid/\nsecret', '模拟二维码', null]) {
    assert.throws(() => renderQrDataUrl(value), { name: 'TypeError', message: '二维码内容无效或过长。' });
  }
});
