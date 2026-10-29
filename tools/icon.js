// Renders the app icon to SVG and PNG. Zero dependencies (node:zlib for PNG deflate).
//
// Usage: node tools/icon.js   → app/public/icon.svg, icon-192.png, icon-512.png, icon-maskable-512.png

import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { join } from 'node:path';
import { root } from './lib.js';

const BG = [13, 107, 89];  // --accent
const FG = [255, 255, 255];

// Geometry in a 0..1 unit square. Signed distance functions; negative = inside.
const sdRoundRect = (x, y, cx, cy, hw, hh, r) => {
  const qx = Math.abs(x - cx) - hw + r, qy = Math.abs(y - cy) - hh + r;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
};
const sdCircle = (x, y, cx, cy, r) => Math.hypot(x - cx, y - cy) - r;

function glyph(x, y, s = 1) {
  // scale about the centre for the maskable variant
  x = 0.5 + (x - 0.5) / s; y = 0.5 + (y - 0.5) / s;
  const body = sdRoundRect(x, y, 0.5, 0.6, 0.2, 0.15, 0.045);
  // shackle: ring of radius .125, thickness .045, upper half + legs down into the body
  const ringD = Math.abs(Math.hypot(x - 0.5, y - 0.42) - 0.125) - 0.0275;
  const shackle = y <= 0.42 ? ringD : Math.min(Math.abs(x - 0.375), Math.abs(x - 0.625)) - 0.0275 + Math.max(0, y - 0.5);
  const keyhole = Math.min(sdCircle(x, y, 0.5, 0.58, 0.04), sdRoundRect(x, y, 0.5, 0.645, 0.016, 0.045, 0.012));
  const lock = Math.min(body, shackle);
  return Math.max(lock, -keyhole);
}

function render(size, { maskable = false } = {}) {
  const px = new Uint8Array(size * size * 4);
  const SS = 4;
  for (let j = 0; j < size; j++) for (let i = 0; i < size; i++) {
    let bg = 0, fg = 0;
    for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
      const x = (i + (sx + 0.5) / SS) / size, y = (j + (sy + 0.5) / SS) / size;
      const inBg = maskable ? true : sdRoundRect(x, y, 0.5, 0.5, 0.5, 0.5, 0.225) <= 0;
      if (inBg) { bg++; if (glyph(x, y, maskable ? 0.8 : 1) <= 0) fg++; }
    }
    const n = SS * SS, a = bg / n, f = bg ? fg / bg : 0;
    const o = (j * size + i) * 4;
    for (let c = 0; c < 3; c++) px[o + c] = Math.round(BG[c] * (1 - f) + FG[c] * f);
    px[o + 3] = Math.round(a * 255);
  }
  return png(size, size, px);
}

const CRC = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
const crc32 = (buf) => { let c = -1; for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ -1) >>> 0; };

function png(w, h, rgba) {
  const chunk = (type, data) => {
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    out.write(type, 4, 'ascii');
    Buffer.from(data).copy(out, 8);
    out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) Buffer.from(rgba.buffer, y * w * 4, w * 4).copy(raw, y * (w * 4 + 1) + 1);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
<rect width="100" height="100" rx="22.5" fill="rgb(${BG})"/>
<path d="M37.5 50V42a12.5 12.5 0 0 1 25 0v8" fill="none" stroke="#fff" stroke-width="5.5"/>
<path fill="#fff" fill-rule="evenodd" d="M34.5 45h31a4.5 4.5 0 0 1 4.5 4.5v21a4.5 4.5 0 0 1-4.5 4.5h-31a4.5 4.5 0 0 1-4.5-4.5v-21a4.5 4.5 0 0 1 4.5-4.5ZM50 54a4 4 0 0 0-1.6 7.7V68a1.6 1.6 0 0 0 3.2 0v-6.3A4 4 0 0 0 50 54Z"/>
</svg>
`;

const out = join(root, 'app/public');
writeFileSync(join(out, 'icon.svg'), svg);
writeFileSync(join(out, 'icon-192.png'), render(192));
writeFileSync(join(out, 'icon-512.png'), render(512));
writeFileSync(join(out, 'icon-maskable-512.png'), render(512, { maskable: true }));
console.log('wrote app/public/icon.svg, icon-192.png, icon-512.png, icon-maskable-512.png');
