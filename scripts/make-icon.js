'use strict';
// Generates the app icons with no dependencies:
//   assets/icon.png  256px window / toast icon
//   assets/tray.png  32px tray icon (no ringing arcs, bolder badge)
//   assets/icon.ico  16-256px, Windows window icon
//   build/icon.png   512px, electron-builder (Linux AppImage/deb icon)
//   build/icon.ico   16-256px, electron-builder (Windows exe, installer, uninstaller)
// Usage: node scripts/make-icon.js [--size=<px>]  (--size sets build/icon.png, default 512)
// Artwork: a white screen with a play button on a rounded Twitch-purple tile, with a red live dot.
// Drawn in a 128-unit space and supersampled at each output size.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SS = 5; // supersampling per axis

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

function inRoundedRect(x, y, x0, y0, x1, y1, r) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = Math.max(x0 + r, Math.min(x, x1 - r));
  const cy = Math.max(y0 + r, Math.min(y, y1 - r));
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}
const inCircle = (x, y, cx, cy, r) => (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);

// A white screen on a stand with a purple play button, and a red "live" dot, on a Twitch-purple tile.
function inTriangle(x, y, [ax, ay], [bx, by], [cx, cy]) {
  const d = (x1, y1, x2, y2, x3, y3) => (x1 - x3) * (y2 - y3) - (x2 - x3) * (y1 - y3);
  const d1 = d(x, y, ax, ay, bx, by), d2 = d(x, y, bx, by, cx, cy), d3 = d(x, y, cx, cy, ax, ay);
  return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
}
const screenBox = (x, y) => inRoundedRect(x, y, 22, 30, 106, 88, 10);
const stand = (x, y) => inRoundedRect(x, y, 57, 86, 71, 99, 2) || inRoundedRect(x, y, 42, 97, 86, 104, 3.5);
const play = (x, y) => inTriangle(x, y, [55, 45], [55, 73], [78, 59]);

const TOP = [0xa9, 0x70, 0xff], BOTTOM = [0x77, 0x2c, 0xe8];
const RED = [0xff, 0x3b, 0x3b], RED_DARK = [0xe9, 0x19, 0x16];

function sample(x, y, opts) {
  if (!inRoundedRect(x, y, 4, 4, 124, 124, 28)) return [0, 0, 0, 0];
  const t = Math.min(1, Math.max(0, (x * 0.35 + y) / (1.35 * 128)));
  let c = mix(TOP, BOTTOM, t);
  if (y < 64) c = mix(c, [255, 255, 255], 0.08 * (1 - y / 64)); // soft top highlight
  if (screenBox(x - 1.5, y - 3) || stand(x - 1.5, y - 3)) c = mix(c, [0x2a, 0x0a, 0x60], 0.3); // shadow
  if (screenBox(x, y) || stand(x, y)) c = [255, 255, 255];
  if (play(x, y)) c = mix(TOP, BOTTOM, 0.55);
  const [cx, cy, r] = opts.dot;
  if (inCircle(x, y, cx, cy, r + 5)) c = [255, 255, 255];
  if (inCircle(x, y, cx, cy, r)) c = mix(RED, RED_DARK, (y - (cy - r)) / (2 * r));
  return [...c, 255];
}

function render(size, opts) {
  const k = 128 / size;
  const px = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const acc = [0, 0, 0, 0];
    for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
      const p = sample((x + (sx + 0.5) / SS) * k, (y + (sy + 0.5) / SS) * k, opts);
      // premultiply so edge pixels don't pick up black
      acc[0] += p[0] * p[3]; acc[1] += p[1] * p[3]; acc[2] += p[2] * p[3]; acc[3] += p[3];
    }
    const o = (y * size + x) * 4;
    const a = acc[3] / (SS * SS);
    px[o + 3] = Math.round(a);
    for (let i = 0; i < 3; i++) px[o + i] = acc[3] ? Math.round(acc[i] / acc[3]) : 0;
  }
  return px;
}

function png(size, px) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    px.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ICO with PNG-compressed entries (Windows Vista and later).
function ico(images) {
  const head = Buffer.alloc(6 + 16 * images.length);
  head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(images.length, 4);
  let offset = head.length;
  images.forEach(({ size, data }, i) => {
    const e = 6 + 16 * i;
    head[e] = size >= 256 ? 0 : size; head[e + 1] = size >= 256 ? 0 : size;
    head.writeUInt16LE(1, e + 4); head.writeUInt16LE(32, e + 6);
    head.writeUInt32LE(data.length, e + 8); head.writeUInt32LE(offset, e + 12);
    offset += data.length;
  });
  return Buffer.concat([head, ...images.map((im) => im.data)]);
}

const FULL = { dot: [101, 29, 11] };
const SMALL = { dot: [98, 31, 15] }; // bolder dot at tiny sizes

const dir = path.join(__dirname, '..', 'assets');
fs.mkdirSync(dir, { recursive: true });

const icoImages = [16, 24, 32, 48, 64, 128, 256].map((size) => ({ size, data: png(size, render(size, size <= 32 ? SMALL : FULL)) }));
fs.writeFileSync(path.join(dir, 'icon.ico'), ico(icoImages));
fs.writeFileSync(path.join(dir, 'icon.png'), icoImages.find((i) => i.size === 256).data);
fs.writeFileSync(path.join(dir, 'tray.png'), png(32, render(32, SMALL)));
console.log('wrote icon.ico, icon.png, tray.png to', dir);

// Packaging icons for electron-builder.
const sizeArg = process.argv.find((a) => a.startsWith('--size='));
const bigSize = Math.max(256, parseInt(sizeArg ? sizeArg.slice(7) : '512', 10) || 512);
const buildDir = path.join(__dirname, '..', 'build');
fs.mkdirSync(buildDir, { recursive: true });
fs.writeFileSync(path.join(buildDir, 'icon.ico'), ico(icoImages));
fs.writeFileSync(path.join(buildDir, 'icon.png'), png(bigSize, render(bigSize, FULL)));
console.log(`wrote icon.ico, icon.png (${bigSize}px) to`, buildDir);
