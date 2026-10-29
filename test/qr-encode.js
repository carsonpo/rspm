// QR code encoder and image renderer, for testing core/qr.js only — never
// shipped. Written separately from the decoder (after Project Nayuki's
// generator) so the two don't share placement code; test/vectors/qr.json and
// the end-to-end check against the browser's BarcodeDetector are the
// independent references.

const EXP = new Uint8Array(512), LOG = new Uint8Array(256);
for (let i = 0, x = 1; i < 255; i++) { EXP[i] = x; LOG[x] = i; x = (x << 1) ^ (x & 0x80 ? 0x11d : 0); }
for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
const mul = (a, b) => (a && b ? EXP[LOG[a] + LOG[b]] : 0);

const ECC = {
  L: [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  M: [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
  Q: [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  H: [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
};
const BLOCKS = {
  L: [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
  M: [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
  Q: [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
  H: [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81],
};
const FORMAT_BITS = { L: 1, M: 0, Q: 3, H: 2 };
const ALNUM = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:';

function rawModules(v) {
  let n = (16 * v + 128) * v + 64;
  if (v >= 2) { const a = Math.floor(v / 7) + 2; n -= (25 * a - 10) * a - 55; if (v >= 7) n -= 36; }
  return n;
}
const dataCapacity = (v, level) => Math.floor(rawModules(v) / 8) - ECC[level][v] * BLOCKS[level][v];

function countBits(mode, v) {
  const i = v < 10 ? 0 : v < 27 ? 1 : 2;
  return { numeric: [10, 12, 14], alnum: [9, 11, 13], byte: [8, 16, 16], kanji: [8, 10, 12] }[mode][i];
}

/**
 * Segments: a string (UTF-8 bytes), or a list of { numeric | alnum | byte
 * (Uint8Array or string) | kanji (Shift JIS code points) | eci (number) }.
 */
function segmentBits(segs, v) {
  const out = [];
  const put = (val, n) => { for (let i = n - 1; i >= 0; i--) out.push((val >>> i) & 1); };
  for (const s of typeof segs === 'string' ? [{ byte: segs }] : segs) {
    if (s.numeric !== undefined) {
      put(1, 4); put(s.numeric.length, countBits('numeric', v));
      for (let i = 0; i < s.numeric.length; i += 3) { const d = s.numeric.slice(i, i + 3); put(Number(d), [0, 4, 7, 10][d.length]); }
    } else if (s.alnum !== undefined) {
      put(2, 4); put(s.alnum.length, countBits('alnum', v));
      for (let i = 0; i + 1 < s.alnum.length; i += 2) put(ALNUM.indexOf(s.alnum[i]) * 45 + ALNUM.indexOf(s.alnum[i + 1]), 11);
      if (s.alnum.length % 2) put(ALNUM.indexOf(s.alnum.at(-1)), 6);
    } else if (s.byte !== undefined) {
      const b = typeof s.byte === 'string' ? new TextEncoder().encode(s.byte) : s.byte;
      put(4, 4); put(b.length, countBits('byte', v));
      for (const x of b) put(x, 8);
    } else if (s.kanji !== undefined) {
      put(8, 4); put(s.kanji.length, countBits('kanji', v));
      for (const c of s.kanji) { const d = c - (c < 0xe040 ? 0x8140 : 0xc140); put((d >> 8) * 0xc0 + (d & 0xff), 13); }
    } else if (s.eci !== undefined) {
      put(7, 4);
      if (s.eci < 128) put(s.eci, 8); else if (s.eci < 16384) put(0x8000 | s.eci, 16); else put(0xc00000 | s.eci, 24);
    }
  }
  return out;
}

function rsRemainder(data, degree) {
  const div = new Array(degree - 1).fill(0); div.push(1);
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < div.length; j++) { div[j] = mul(div[j], root); if (j + 1 < div.length) div[j] ^= div[j + 1]; }
    root = mul(root, 2);
  }
  const r = new Array(degree).fill(0);
  for (const b of data) {
    const f = b ^ r.shift(); r.push(0);
    div.forEach((c, i) => { r[i] ^= mul(c, f); });
  }
  return r;
}

/** RS check codewords, exported so tests can corrupt blocks directly. */
export const rsEncode = (data, ecc) => Uint8Array.from([...data, ...rsRemainder(data, ecc)]);

/** Smallest version that holds the segments at this level. */
export function fitVersion(segs, level) {
  for (let v = 1; v <= 40; v++) if (segmentBits(segs, v).length <= dataCapacity(v, level) * 8) return v;
  throw new Error('too much data');
}

/** Returns { size, modules } (Uint8Array, 1 = dark, indexed y * size + x). */
export function encode(segs, { level = 'M', version, mask = 0 } = {}) {
  const v = version ?? fitVersion(segs, level);
  const cap = dataCapacity(v, level) * 8;
  const bits = segmentBits(segs, v);
  if (bits.length > cap) throw new Error('too much data for this version');
  for (let i = 0; i < 4 && bits.length < cap; i++) bits.push(0);
  while (bits.length % 8) bits.push(0);
  const data = [];
  for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));
  for (let pad = 0xec; data.length < cap / 8; pad ^= 0xec ^ 0x11) data.push(pad);

  // Split into blocks, add ECC, interleave.
  const nb = BLOCKS[level][v], ecc = ECC[level][v], total = Math.floor(rawModules(v) / 8);
  const nShort = nb - (total % nb), shortLen = Math.floor(total / nb);
  const blocks = [];
  for (let i = 0, k = 0; i < nb; i++) {
    const d = data.slice(k, k + shortLen - ecc + (i < nShort ? 0 : 1));
    k += d.length;
    const b = [...d, ...rsRemainder(d, ecc)];
    if (i < nShort) b.splice(shortLen - ecc, 0, 0);
    blocks.push(b);
  }
  const words = [];
  for (let i = 0; i < blocks[0].length; i++) blocks.forEach((b, j) => { if (i !== shortLen - ecc || j >= nShort) words.push(b[i]); });

  const size = v * 4 + 17;
  const m = new Uint8Array(size * size), fn = new Uint8Array(size * size);
  const set = (x, y, dark) => { m[y * size + x] = dark ? 1 : 0; fn[y * size + x] = 1; };
  for (let i = 0; i < size; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]]) {
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
      const x = cx + dx, y = cy + dy, d = Math.max(Math.abs(dx), Math.abs(dy));
      if (x >= 0 && y >= 0 && x < size && y < size) set(x, y, d !== 2 && d !== 4);
    }
  }
  const al = [];
  if (v > 1) {
    const n = Math.floor(v / 7) + 2, step = Math.floor((v * 8 + n * 3 + 5) / (n * 4 - 4)) * 2;
    al.push(6);
    for (let p = size - 7; al.length < n; p -= step) al.splice(1, 0, p);
  }
  for (let i = 0; i < al.length; i++) for (let j = 0; j < al.length; j++) {
    if ((i === 0 && j === 0) || (i === 0 && j === al.length - 1) || (i === al.length - 1 && j === 0)) continue;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(al[i] + dx, al[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
  }
  // Format (reserved now, drawn after masking) and version.
  const drawFormat = () => {
    const d = (FORMAT_BITS[level] << 3) | mask;
    let r = d;
    for (let i = 0; i < 10; i++) r = (r << 1) ^ ((r >>> 9) * 0x537);
    const f = ((d << 10) | r) ^ 0x5412, bit = (i) => (f >>> i) & 1;
    for (let i = 0; i <= 5; i++) set(8, i, bit(i));
    set(8, 7, bit(6)); set(8, 8, bit(7)); set(7, 8, bit(8));
    for (let i = 9; i < 15; i++) set(14 - i, 8, bit(i));
    for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(i));
    set(8, size - 8, 1);
  };
  drawFormat();
  if (v >= 7) {
    let r = v;
    for (let i = 0; i < 12; i++) r = (r << 1) ^ ((r >>> 11) * 0x1f25);
    const f = (v << 12) | r;
    for (let i = 0; i < 18; i++) { const a = size - 11 + (i % 3), b = Math.floor(i / 3); set(a, b, (f >>> i) & 1); set(b, a, (f >>> i) & 1); }
  }
  const masks = [
    (x, y) => (x + y) % 2 === 0, (x, y) => y % 2 === 0, (x) => x % 3 === 0, (x, y) => (x + y) % 3 === 0,
    (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0, (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
    (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0, (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
  ];
  let i = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j, y = ((right + 1) & 2) === 0 ? size - 1 - vert : vert;
        if (fn[y * size + x]) continue;
        const bit = i < words.length * 8 ? (words[i >>> 3] >>> (7 - (i & 7))) & 1 : 0;
        m[y * size + x] = bit ^ (masks[mask](x, y) ? 1 : 0);
        i++;
      }
    }
  }
  return { size, modules: m, version: v };
}

// ── Rendering ───────────────────────────────────────────────────────────────

/** Deterministic PRNG for reproducible noise. */
export function prng(seed) {
  let s = seed >>> 0 || 1;
  return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return (s >>> 0) / 2 ** 32; };
}

/**
 * Renders a code into RGBA pixels. `corners` places the code's four outer
 * corners (TL, TR, BR, BL) in the image; by default it's upright at `scale`
 * pixels per module with a 4-module quiet zone. Options add blur, noise,
 * uneven lighting, low contrast, inversion and transparency.
 */
export function render({ size, modules }, {
  scale = 4, quiet = 4, width, height, corners, blur = 0, noise = 0, contrast = 1, gradient = 0,
  invert = false, transparent = false, background = null, seed = 1,
} = {}) {
  const W = width ?? (size + 2 * quiet) * scale, H = height ?? (size + 2 * quiet) * scale;
  const q = corners ?? [[quiet * scale, quiet * scale], [(quiet + size) * scale, quiet * scale], [(quiet + size) * scale, (quiet + size) * scale], [quiet * scale, (quiet + size) * scale]];
  const toModule = homographyOf(q, [[0, 0], [size, 0], [size, size], [0, size]]);
  const dark = new Float64Array(W * H);
  const SS = 3; // supersampling for anti-aliased edges
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let d = 0;
      for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
        const [mx, my] = toModule(x + (sx + 0.5) / SS, y + (sy + 0.5) / SS);
        const ix = Math.floor(mx), iy = Math.floor(my);
        if (ix >= 0 && iy >= 0 && ix < size && iy < size && modules[iy * size + ix]) d++;
        else if (background && !(ix >= -quiet && iy >= -quiet && ix < size + quiet && iy < size + quiet)) d += background(x, y);
      }
      dark[y * W + x] = d / (SS * SS);
    }
  }
  const blurred = blur ? boxBlur(boxBlur(dark, W, H, blur), W, H, blur) : dark;
  const rnd = prng(seed);
  const out = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    let d = blurred[i];
    if (invert) d = 1 - d;
    const x = i % W, y = Math.floor(i / W);
    const light = 1 - gradient * (x / W + y / H) / 2;
    let v = (255 * (1 - d) * contrast + 255 * (1 - contrast) / 2) * light;
    v += (rnd() - 0.5) * 2 * noise;
    if (transparent) {
      out.set([0, 0, 0, Math.round(255 * d)], i * 4);
    } else {
      out.set([v, v, v, 255], i * 4);
    }
  }
  return { data: out, width: W, height: H };
}

function boxBlur(src, W, H, r) {
  const tmp = new Float64Array(W * H), out = new Float64Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let s = 0, n = 0;
    for (let k = -r; k <= r; k++) { const xx = x + k; if (xx >= 0 && xx < W) { s += src[y * W + xx]; n++; } }
    tmp[y * W + x] = s / n;
  }
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let s = 0, n = 0;
    for (let k = -r; k <= r; k++) { const yy = y + k; if (yy >= 0 && yy < H) { s += tmp[yy * W + x]; n++; } }
    out[y * W + x] = s / n;
  }
  return out;
}

// Its own homography so the renderer doesn't lean on the decoder's.
function homographyOf(src, dst) {
  const m = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = src[i], [u, v] = dst[i];
    m.push([x, y, 1, 0, 0, 0, -x * u, -y * u, u], [0, 0, 0, x, y, 1, -x * v, -y * v, v]);
  }
  for (let c = 0; c < 8; c++) {
    let p = c;
    for (let r = c + 1; r < 8; r++) if (Math.abs(m[r][c]) > Math.abs(m[p][c])) p = r;
    [m[c], m[p]] = [m[p], m[c]];
    for (let r = 0; r < 8; r++) if (r !== c) { const f = m[r][c] / m[c][c]; for (let k = c; k < 9; k++) m[r][k] -= f * m[c][k]; }
  }
  const [a, b, c, d, e, f, g, h] = m.map((row, i) => row[8] / row[i]);
  return (x, y) => { const z = g * x + h * y + 1; return [(a * x + b * y + c) / z, (d * x + e * y + f) / z]; };
}

/** Corners for a code rotated by `deg` about the image centre, with optional perspective squeeze of the right edge. */
export function placed(size, { scale = 4, deg = 0, squeeze = 0, W, H }) {
  const s = size * scale, cx = W / 2, cy = H / 2;
  const pts = [[-s / 2, -s / 2], [s / 2, -s / 2 * (1 - squeeze)], [s / 2, s / 2 * (1 - squeeze)], [-s / 2, s / 2]];
  const r = (deg * Math.PI) / 180;
  return pts.map(([x, y]) => [cx + x * Math.cos(r) - y * Math.sin(r), cy + x * Math.sin(r) + y * Math.cos(r)]);
}

/**
 * A Google Authenticator export URI. Accounts: { secret (bytes), name,
 * issuer, algorithm (1 SHA1, 2 SHA256, 3 SHA512), digits (1 six, 2 eight),
 * type (1 HOTP, 2 TOTP) }.
 */
export function migrationUri(accounts) {
  const varint = (n) => { const o = []; do { o.push((n & 0x7f) | (n > 0x7f ? 0x80 : 0)); n >>>= 7; } while (n); return o; };
  const bytes = (f, b) => [...varint((f << 3) | 2), ...varint(b.length), ...b];
  const num = (f, n) => [...varint(f << 3), ...varint(n)];
  const utf8 = (s) => [...new TextEncoder().encode(s)];
  const payload = Uint8Array.from([
    ...accounts.flatMap((a) => bytes(1, [
      ...bytes(1, a.secret), ...bytes(2, utf8(a.name)), ...bytes(3, utf8(a.issuer ?? '')),
      ...num(4, a.algorithm ?? 1), ...num(5, a.digits ?? 1), ...num(6, a.type ?? 2),
    ])),
    ...num(2, 1), ...num(3, 1),
  ]);
  return `otpauth-migration://offline?data=${encodeURIComponent(btoa(String.fromCharCode(...payload)))}`;
}

/** The longest text built from `prefix` + repeats of `filler` that still fits `version` at `level`. */
export function fillVersion(version, level, prefix = '', filler = 'otpauth://totp/') {
  const full = prefix + filler.repeat(Math.ceil(3000 / filler.length));
  const fits = (n) => { try { return fitVersion(full.slice(0, n), level) <= version; } catch { return false; } };
  let lo = 1, hi = full.length;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (fits(mid)) lo = mid; else hi = mid - 1; }
  return full.slice(0, lo);
}
