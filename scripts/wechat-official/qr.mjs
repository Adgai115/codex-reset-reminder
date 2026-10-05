import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const QRCode = require('qrcode-terminal/vendor/QRCode');
const errorCorrection = require('qrcode-terminal/vendor/QRCode/QRErrorCorrectLevel');

/** Render the authorization URL locally without logging it or fetching an image. */
export function renderQrDataUrl(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 1024
      || /[^\x21-\x7e]/u.test(value)) {
    throw new TypeError('二维码内容无效或过长。');
  }
  const qr = new QRCode(-1, errorCorrection.M);
  qr.addData(value);
  qr.make();
  const quietZone = 4;
  const moduleCount = qr.getModuleCount();
  const size = moduleCount + quietZone * 2;
  const pixels = [];
  for (let row = 0; row < moduleCount; row += 1) {
    for (let column = 0; column < moduleCount; column += 1) {
      if (qr.isDark(row, column)) {
        pixels.push(`M${column + quietZone} ${row + quietZone}h1v1h-1z`);
      }
    }
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="white"/><path fill="black" d="${pixels.join('')}"/></svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`;
}
