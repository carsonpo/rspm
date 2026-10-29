// QR code reader (ISO/IEC 18004), for scanning two-factor setup codes from a
// camera frame or a screenshot. Decoding only.
//
//   pixels → luminance → binarize with local thresholds → find the three
//   finder patterns → locate the alignment pattern → sample the module grid
//   through a perspective transform → format and version information →
//   unmask → de-interleave → Reed–Solomon → segments → text
//
// Detection follows the approach of ZXing's detector. Everything runs on the
// device; nothing here keeps a copy of the image.

export class QRError extends Error {}

/**
 * Finds and decodes a QR code in RGBA pixels ({ data, width, height }, as from
 * getImageData). Returns the text of the first code that decodes, or null.
 */
export function scan({ data, width, height }) {
  const lum = luminance(data, width, height);
  for (const binarize of [hybrid, otsu]) {
    const img = { bits: binarize(lum, width, height), w: width, h: height };
    for (const inverted of [false, true]) {
      if (inverted) for (let i = 0; i < img.bits.length; i++) img.bits[i] ^= 1;
      const text = locate(img);
      if (text !== null) return text;
    }
  }
  return null;
}

// ── Binarization ────────────────────────────────────────────────────────────

/** Luminance 0–255, with transparency composited over white. */
function luminance(rgba, w, h) {
  const out = new Uint8Array(w * h);
  for (let i = 0, j = 0; i < out.length; i++, j += 4) {
    const a = rgba[j + 3], y = (rgba[j] + 2 * rgba[j + 1] + rgba[j + 2]) >> 2;
    out[i] = (y * a + 255 * (255 - a)) / 255;
  }
  return out;
}

const BLOCK = 8;

/** Local thresholds from 8×8 blocks averaged over a 5×5 neighbourhood (ZXing's HybridBinarizer). 1 = dark. */
function hybrid(lum, w, h) {
  if (w < BLOCK * 5 || h < BLOCK * 5) return otsu(lum, w, h);
  const bw = Math.ceil(w / BLOCK), bh = Math.ceil(h / BLOCK);
  const black = new Float64Array(bw * bh);
  for (let by = 0; by < bh; by++) {
    const y0 = Math.min(by * BLOCK, h - BLOCK);
    for (let bx = 0; bx < bw; bx++) {
      const x0 = Math.min(bx * BLOCK, w - BLOCK);
      let sum = 0, min = 255, max = 0;
      for (let y = y0; y < y0 + BLOCK; y++) {
        for (let i = y * w + x0, end = i + BLOCK; i < end; i++) {
          const v = lum[i];
          sum += v;
          if (v < min) min = v;
          if (v > max) max = v;
        }
      }
      let t = sum / (BLOCK * BLOCK);
      if (max - min <= 24) {
        // A flat block: assume it's background unless its neighbours say otherwise.
        t = min / 2;
        if (by > 0 && bx > 0) {
          const near = (black[(by - 1) * bw + bx] + 2 * black[by * bw + bx - 1] + black[(by - 1) * bw + bx - 1]) / 4;
          if (min < near) t = near;
        }
      }
      black[by * bw + bx] = t;
    }
  }
  const bits = new Uint8Array(w * h);
  for (let by = 0; by < bh; by++) {
    const y0 = Math.min(by * BLOCK, h - BLOCK), cy = Math.min(Math.max(by, 2), bh - 3);
    for (let bx = 0; bx < bw; bx++) {
      const x0 = Math.min(bx * BLOCK, w - BLOCK), cx = Math.min(Math.max(bx, 2), bw - 3);
      let sum = 0;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) sum += black[(cy + dy) * bw + cx + dx];
      const t = sum / 25;
      for (let y = y0; y < y0 + BLOCK; y++) {
        for (let i = y * w + x0, end = i + BLOCK; i < end; i++) bits[i] = lum[i] <= t ? 1 : 0;
      }
    }
  }
  return bits;
}

/** One global threshold (Otsu's method), for small or evenly lit images. */
function otsu(lum, w, h) {
  const hist = new Float64Array(256);
  for (const v of lum) hist[v]++;
  let total = 0;
  for (let i = 0; i < 256; i++) total += i * hist[i];
  let best = 0, t = 127, sumB = 0, wB = 0;
  for (let i = 0; i < 256; i++) {
    wB += hist[i];
    if (!wB) continue;
    const wF = lum.length - wB;
    if (!wF) break;
    sumB += i * hist[i];
    const between = wB * wF * (sumB / wB - (total - sumB) / wF) ** 2;
    if (between > best) { best = between; t = i; }
  }
  const bits = new Uint8Array(w * h);
  for (let i = 0; i < bits.length; i++) bits[i] = lum[i] <= t ? 1 : 0;
  return bits;
}

// ── Finder patterns ─────────────────────────────────────────────────────────

/** Whether five run lengths look like 1:1:3:1:1, within `tol` of a module. */
function finderRatio(s, tol = 0.5) {
  const total = s[0] + s[1] + s[2] + s[3] + s[4];
  if (total < 7) return false;
  const m = total / 7, v = m * tol;
  return Math.abs(m - s[0]) < v && Math.abs(m - s[1]) < v && Math.abs(3 * m - s[2]) < 3 * v &&
    Math.abs(m - s[3]) < v && Math.abs(m - s[4]) < v;
}

/**
 * Re-measures a candidate along the line through (x0, y0) in direction
 * (dx, dy). Returns the offset of the pattern's centre along that line, or NaN.
 * `total`, when given, is the length the first measurement found.
 */
function cross({ bits, w, h }, x0, y0, dx, dy, maxCount, total, tol) {
  const at = (k) => {
    const x = x0 + dx * k, y = y0 + dy * k;
    return x < 0 || y < 0 || x >= w || y >= h ? -1 : bits[y * w + x];
  };
  const s = [0, 0, 0, 0, 0];
  let k = 0;
  while (at(k) === 1) { s[2]++; k--; }
  if (at(k) < 0) return NaN;
  while (at(k) === 0 && s[1] <= maxCount) { s[1]++; k--; }
  if (at(k) < 0 || s[1] > maxCount) return NaN;
  while (at(k) === 1 && s[0] <= maxCount) { s[0]++; k--; }
  if (s[0] > maxCount) return NaN;
  k = 1;
  while (at(k) === 1) { s[2]++; k++; }
  if (at(k) < 0) return NaN;
  while (at(k) === 0 && s[3] <= maxCount) { s[3]++; k++; }
  if (at(k) < 0 || s[3] > maxCount) return NaN;
  while (at(k) === 1 && s[4] <= maxCount) { s[4]++; k++; }
  if (s[4] > maxCount) return NaN;
  const t = s[0] + s[1] + s[2] + s[3] + s[4];
  if (total && 5 * Math.abs(t - total) >= 2 * total) return NaN;
  return finderRatio(s, tol) ? k - s[4] - s[3] - s[2] / 2 : NaN;
}

/** Candidate finder pattern centres: { x, y, size (module size), count (times seen) }. */
function findFinders(img) {
  const { bits, w, h } = img;
  const found = [];
  const confirm = (s, endX, y) => {
    const total = s[0] + s[1] + s[2] + s[3] + s[4];
    let cx = endX - s[4] - s[3] - s[2] / 2;
    const oy = cross(img, Math.floor(cx), y, 0, 1, s[2], total, 0.5);
    if (Number.isNaN(oy)) return false;
    const cy = y + oy;
    const ox = cross(img, Math.floor(cx), Math.floor(cy), 1, 0, s[2], total, 0.5);
    if (Number.isNaN(ox)) return false;
    cx = Math.floor(cx) + ox;
    if (Number.isNaN(cross(img, Math.floor(cx), Math.floor(cy), 1, 1, Infinity, 0, 0.75))) return false;
    const size = total / 7;
    for (const c of found) {
      if (Math.abs(cy - c.y) <= size && Math.abs(cx - c.x) <= size && (Math.abs(size - c.size) <= 1 || Math.abs(size - c.size) <= c.size)) {
        const n = c.count + 1;
        c.x = (c.count * c.x + cx) / n; c.y = (c.count * c.y + cy) / n; c.size = (c.count * c.size + size) / n; c.count = n;
        return true;
      }
    }
    found.push({ x: cx, y: cy, size, count: 1 });
    return true;
  };
  const skip = h < 400 ? 1 : 2;
  for (let y = skip - 1; y < h; y += skip) {
    const s = [0, 0, 0, 0, 0];
    let state = 0;
    for (let x = 0, i = y * w; x < w; x++, i++) {
      if (bits[i]) {
        if (state & 1) state++;
        s[state]++;
      } else if (state & 1) {
        s[state]++;
      } else if (state === 4) {
        if (finderRatio(s) && confirm(s, x, y)) { s.fill(0); state = 0; continue; }
        s[0] = s[2]; s[1] = s[3]; s[2] = s[4]; s[3] = 1; s[4] = 0; state = 3;
      } else {
        s[++state]++;
      }
    }
    if (state === 4 && finderRatio(s)) confirm(s, w, y);
  }
  return found;
}

/** Plausible (top-left, top-right, bottom-left) triples, best first. */
function triples(found) {
  let c = found.filter((p) => p.count >= 2);
  if (c.length < 3) c = found;
  c = [...c].sort((a, b) => b.count - a.count).slice(0, 12);
  const out = [];
  for (let i = 0; i < c.length; i++) {
    for (let j = i + 1; j < c.length; j++) {
      for (let k = j + 1; k < c.length; k++) {
        const p = [c[i], c[j], c[k]];
        const sizes = p.map((q) => q.size);
        const sizeRatio = Math.max(...sizes) / Math.min(...sizes);
        if (sizeRatio > 2.5) continue; // steep perspective shrinks the far patterns
        // The corner is opposite the longest side.
        const d = [dist2(p[1], p[2]), dist2(p[0], p[2]), dist2(p[0], p[1])];
        const v = d.indexOf(Math.max(...d));
        const tl = p[v];
        let [a, b] = p.filter((_, n) => n !== v);
        const l1 = Math.sqrt(dist2(tl, a)), l2 = Math.sqrt(dist2(tl, b));
        const ms = (sizes[0] + sizes[1] + sizes[2]) / 3;
        if (Math.min(l1, l2) < 8 * ms) continue;
        const cos = ((a.x - tl.x) * (b.x - tl.x) + (a.y - tl.y) * (b.y - tl.y)) / (l1 * l2);
        const legRatio = Math.max(l1, l2) / Math.min(l1, l2);
        if (Math.abs(cos) > 0.5 || legRatio > 2) continue;
        // Bottom-left is clockwise from top-right around the corner (y points down).
        if ((b.x - tl.x) * (a.y - tl.y) - (b.y - tl.y) * (a.x - tl.x) < 0) [a, b] = [b, a];
        out.push({ tl, tr: b, bl: a, score: Math.abs(cos) + (legRatio - 1) + (sizeRatio - 1) });
      }
    }
  }
  return out.sort((x, y) => x.score - y.score).slice(0, 10);
}

const dist2 = (a, b) => (a.x - b.x) ** 2 + (a.y - b.y) ** 2;

// ── Geometry ────────────────────────────────────────────────────────────────

/**
 * Length in pixels of the black–white–black run from (fx, fy) toward
 * (tx, ty): from a finder centre that's 3.5 modules. NaN if it doesn't end.
 */
function bwbRun({ bits, w }, fx, fy, tx, ty) {
  const steep = Math.abs(ty - fy) > Math.abs(tx - fx);
  if (steep) [fx, fy, tx, ty] = [fy, fx, ty, tx];
  const dx = Math.abs(tx - fx), dy = Math.abs(ty - fy);
  let err = -dx / 2;
  const xs = fx < tx ? 1 : -1, ys = fy < ty ? 1 : -1;
  let state = 0;
  for (let x = fx, y = fy; x !== tx + xs; x += xs) {
    const rx = steep ? y : x, ry = steep ? x : y;
    if ((state === 1) === (bits[ry * w + rx] === 1)) {
      if (state === 2) return Math.hypot(x - fx, y - fy);
      state++;
    }
    err += dy;
    if (err > 0) {
      if (y === ty) break;
      y += ys;
      err -= dx;
    }
  }
  return state === 2 ? Math.hypot(tx + xs - fx, ty - fy) : NaN;
}

function bwbRunBothWays(img, fx, fy, tx, ty) {
  const { w, h } = img;
  let r = bwbRun(img, fx, fy, tx, ty);
  let scale = 1, ox = fx - (tx - fx);
  if (ox < 0) { scale = fx / (fx - ox); ox = 0; } else if (ox >= w) { scale = (w - 1 - fx) / (ox - fx); ox = w - 1; }
  let oy = Math.floor(fy - (ty - fy) * scale);
  scale = 1;
  if (oy < 0) { scale = fy / (fy - oy); oy = 0; } else if (oy >= h) { scale = (h - 1 - fy) / (oy - fy); oy = h - 1; }
  ox = Math.floor(fx + (ox - fx) * scale);
  r += bwbRun(img, fx, fy, ox, oy);
  return r - 1;
}

/** Module size measured along the line between two finder patterns (each spans 7 modules). */
function moduleSizeAlong(img, a, b) {
  const ax = Math.floor(a.x), ay = Math.floor(a.y), bx = Math.floor(b.x), by = Math.floor(b.y);
  const s1 = bwbRunBothWays(img, ax, ay, bx, by), s2 = bwbRunBothWays(img, bx, by, ax, ay);
  if (Number.isNaN(s1)) return s2 / 7;
  if (Number.isNaN(s2)) return s1 / 7;
  return (s1 + s2) / 14;
}

/** Candidate grid sizes (21, 25, … 177) from the finder spacing. */
function dimensions(tl, tr, bl, ms) {
  const dim = ((Math.round(Math.sqrt(dist2(tl, tr)) / ms) + Math.round(Math.sqrt(dist2(tl, bl)) / ms)) >> 1) + 7;
  const r = dim & 3;
  const dims = r === 1 ? [dim] : r === 0 ? [dim + 1, dim - 3] : r === 2 ? [dim - 1, dim + 3] : [dim + 2, dim - 2];
  return dims.filter((d) => d >= 21 && d <= 177);
}

/**
 * Along the line through (x, y) in direction (dx, dy): a dark run with a light
 * run and then dark on either side, the three in 1:1:1. That holds through the
 * middle of an alignment pattern at any rotation. Returns { c, m }, the centre
 * offset along the line (in steps, pixel-centre convention) and the run size.
 */
function ring({ bits, w, h }, x, y, dx, dy, mMin, mMax) {
  const at = (k) => {
    const px = x + dx * k, py = y + dy * k;
    return px < 0 || py < 0 || px >= w || py >= h ? -1 : bits[py * w + px];
  };
  if (at(0) !== 1) return null;
  let lo = 0, hi = 0;
  while (at(lo - 1) === 1 && hi - lo < 2 * mMax) lo--;
  while (at(hi + 1) === 1 && hi - lo < 2 * mMax) hi++;
  const c = hi - lo + 1;
  let a = 0, k = lo - 1;
  while (at(k) === 0 && a <= 2 * mMax) { a++; k--; }
  if (at(k) !== 1) return null;
  let b = 0;
  k = hi + 1;
  while (at(k) === 0 && b <= 2 * mMax) { b++; k++; }
  if (at(k) !== 1) return null;
  const m = (a + b + c) / 3;
  if (m < mMin || m > mMax || Math.abs(a - m) >= m / 2 || Math.abs(b - m) >= m / 2 || Math.abs(c - m) >= m / 2) return null;
  return { c: (lo + hi) / 2, m };
}

/**
 * Candidates for the bottom-right alignment pattern, searched for outward from
 * where the finder patterns put it, nearest first. Data modules can mimic it,
 * so the caller lets decoding pick.
 */
function findAlignment(img, tl, tr, bl, dim) {
  const n = dim - 7;
  const ex = { x: (tr.x - tl.x) / n, y: (tr.y - tl.y) / n }, ey = { x: (bl.x - tl.x) / n, y: (bl.y - tl.y) / n };
  const px = tl.x + (dim - 10) * (ex.x + ey.x), py = tl.y + (dim - 10) * (ex.y + ey.y);
  const ms = Math.sqrt((ex.x ** 2 + ex.y ** 2 + ey.x ** 2 + ey.y ** 2) / 2);
  const mMin = Math.max(0.6, ms * 0.3), mMax = ms * 2;
  const { bits, w, h } = img;
  const hits = [];
  {
    const r = 16 * ms;
    const x0 = Math.max(0, Math.floor(px - r)), x1 = Math.min(w, Math.ceil(px + r));
    const y0 = Math.max(0, Math.floor(py - r)), y1 = Math.min(h, Math.ceil(py + r));
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        if (!bits[y * w + x] || (x > x0 && bits[y * w + x - 1])) continue; // once per dark run
        const hz = ring(img, x, y, 1, 0, mMin, mMax);
        if (!hz) continue;
        const cx = Math.floor(x + hz.c);
        const vt = ring(img, cx, y, 0, 1, mMin, mMax);
        if (!vt || Math.abs(vt.m - hz.m) > hz.m / 2) continue;
        const cy = Math.floor(y + vt.c);
        const h2 = ring(img, cx, cy, 1, 0, mMin, mMax);
        if (!h2) continue;
        // One diagonal too (at a few pixels per module the other can clip a corner).
        if (!ring(img, Math.floor(cx + h2.c), cy, 1, 1, mMin * 0.7, mMax) && !ring(img, Math.floor(cx + h2.c), cy, 1, -1, mMin * 0.7, mMax)) continue;
        const ax = cx + h2.c + 0.5, ay = cy + 0.5;
        if (!hits.some((p) => Math.abs(p.x - ax) < ms && Math.abs(p.y - ay) < ms)) hits.push({ x: ax, y: ay, d: (ax - px) ** 2 + (ay - py) ** 2 });
      }
    }
  }
  return hits.sort((a, b) => a.d - b.d).slice(0, 6);
}

/** The projective map taking four source points to four destination points: (x, y) → [x', y']. */
export function homography(src, dst) {
  // Solve the 8 unknowns of [a b c; d e f; g h 1] by Gaussian elimination.
  const m = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = src[i], [u, v] = dst[i];
    m.push([x, y, 1, 0, 0, 0, -x * u, -y * u, u]);
    m.push([0, 0, 0, x, y, 1, -x * v, -y * v, v]);
  }
  for (let c = 0; c < 8; c++) {
    let p = c;
    for (let r = c + 1; r < 8; r++) if (Math.abs(m[r][c]) > Math.abs(m[p][c])) p = r;
    if (Math.abs(m[p][c]) < 1e-12) return null;
    [m[c], m[p]] = [m[p], m[c]];
    for (let r = 0; r < 8; r++) {
      if (r === c) continue;
      const f = m[r][c] / m[c][c];
      for (let k = c; k < 9; k++) m[r][k] -= f * m[c][k];
    }
  }
  const [a, b, c, d, e, f, g, hh] = m.map((row, i) => row[8] / row[i]);
  return (x, y) => { const z = g * x + hh * y + 1; return [(a * x + b * y + c) / z, (d * x + e * y + f) / z]; };
}

/** Samples a dim×dim module grid (1 = dark) at each module's centre. */
function sample({ bits, w, h }, map, dim) {
  const grid = new Uint8Array(dim * dim);
  let outside = 0;
  for (let y = 0; y < dim; y++) {
    for (let x = 0; x < dim; x++) {
      const [px, py] = map(x + 0.5, y + 0.5);
      const ix = Math.floor(px), iy = Math.floor(py);
      if (ix < 0 || iy < 0 || ix >= w || iy >= h) { outside++; continue; }
      grid[y * dim + x] = bits[iy * w + ix];
    }
  }
  return outside > dim ? null : grid;
}

function locate(img) {
  const found = findFinders(img);
  if (found.length < 3) return null;
  for (const { tl, tr, bl } of triples(found)) {
    const ms = (moduleSizeAlong(img, tl, tr) + moduleSizeAlong(img, tl, bl)) / 2;
    if (!(ms > 0)) continue;
    for (const dim of dimensions(tl, tr, bl, ms)) {
      const text = sampleAndDecode(img, tl, tr, bl, dim, true);
      if (text !== null) return text;
    }
  }
  return null;
}

function sampleAndDecode(img, tl, tr, bl, dim, retry) {
  const P = (p) => [p.x, p.y];
  const far = dim - 3.5;
  const maps = (dim > 21 ? findAlignment(img, tl, tr, bl, dim) : [])
    .map((a) => homography([[3.5, 3.5], [far, 3.5], [far - 3, far - 3], [3.5, far]], [P(tl), P(tr), P(a), P(bl)]));
  // Without an alignment pattern, assume a parallelogram.
  maps.push(homography([[3.5, 3.5], [far, 3.5], [far, far], [3.5, far]], [P(tl), P(tr), [tr.x + bl.x - tl.x, tr.y + bl.y - tl.y], P(bl)]));
  let other = 0;
  for (const map of maps) {
    const grid = map && sample(img, map, dim);
    if (!grid) continue;
    try {
      return decodeGrid(grid, dim);
    } catch (e) {
      if (e.dim) other = e.dim;
    }
  }
  // Version information can correct a misjudged size.
  return retry && other && other !== dim ? sampleAndDecode(img, tl, tr, bl, other, false) : null;
}

// ── Code structure (tables as in Project Nayuki's QR Code generator) ────────

// Indexed [level][version] for levels L, M, Q, H.
const ECC_PER_BLOCK = [
  [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
  [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
];
const NUM_BLOCKS = [
  [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
  [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
  [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
  [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81],
];
// Format information encodes L, M, Q, H as 1, 0, 3, 2.
const LEVEL_FROM_FORMAT = [1, 0, 3, 2];
export const LEVELS = ['L', 'M', 'Q', 'H'];

export function rawDataModules(ver) {
  let n = (16 * ver + 128) * ver + 64;
  if (ver >= 2) {
    const a = Math.floor(ver / 7) + 2;
    n -= (25 * a - 10) * a - 55;
    if (ver >= 7) n -= 36;
  }
  return n;
}

export function alignmentPositions(ver) {
  if (ver === 1) return [];
  const n = Math.floor(ver / 7) + 2;
  const step = Math.floor((ver * 8 + n * 3 + 5) / (n * 4 - 4)) * 2;
  const out = [6];
  for (let pos = ver * 4 + 17 - 7; out.length < n; pos -= step) out.splice(1, 0, pos);
  return out;
}

/** Block layout for a version and level (0–3 = L, M, Q, H). */
export function blockLayout(ver, level) {
  const total = Math.floor(rawDataModules(ver) / 8);
  const blocks = NUM_BLOCKS[level][ver], ecc = ECC_PER_BLOCK[level][ver];
  const short = blocks - (total % blocks), shortLen = Math.floor(total / blocks);
  return { total, blocks, ecc, short, shortLen, dataCodewords: total - blocks * ecc };
}

/** 15-bit format words for (level bits << 3 | mask), BCH-coded and masked. */
export const FORMAT_WORDS = Array.from({ length: 32 }, (_, data) => {
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  return ((data << 10) | rem) ^ 0x5412;
});

/** 18-bit version words, BCH-coded, for versions 7–40. */
export const VERSION_WORDS = Array.from({ length: 41 }, (_, v) => {
  let rem = v;
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
  return (v << 12) | rem;
});

export const MASKS = [
  (x, y) => (x + y) % 2 === 0,
  (x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

/** Positions of format bits 0–14, as [x, y], for both copies. */
export function formatPositions(size) {
  const a = [], b = [];
  for (let i = 0; i <= 5; i++) a.push([8, i]);
  a.push([8, 7], [8, 8], [7, 8]);
  for (let i = 9; i < 15; i++) a.push([14 - i, 8]);
  for (let i = 0; i < 8; i++) b.push([size - 1 - i, 8]);
  for (let i = 8; i < 15; i++) b.push([8, size - 15 + i]);
  return [a, b];
}

/** Positions of version bits 0–17, as [x, y], for both copies. */
export function versionPositions(size) {
  const a = [], b = [];
  for (let i = 0; i < 18; i++) {
    const p = size - 11 + (i % 3), q = Math.floor(i / 3);
    a.push([p, q]);
    b.push([q, p]);
  }
  return [a, b];
}

const functionCache = new Map();

/** Which modules are function patterns (not data), for a version. Indexed y * size + x. */
export function functionModules(ver) {
  if (functionCache.has(ver)) return functionCache.get(ver);
  const size = ver * 4 + 17;
  const f = new Uint8Array(size * size);
  const mark = (x, y) => { if (x >= 0 && y >= 0 && x < size && y < size) f[y * size + x] = 1; };
  for (let i = 0; i < size; i++) { mark(6, i); mark(i, 6); }
  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]]) {
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) mark(cx + dx, cy + dy);
  }
  const al = alignmentPositions(ver), n = al.length;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if ((i === 0 && j === 0) || (i === 0 && j === n - 1) || (i === n - 1 && j === 0)) continue;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) mark(al[i] + dx, al[j] + dy);
    }
  }
  for (const copy of formatPositions(size)) for (const [x, y] of copy) mark(x, y);
  mark(8, size - 8); // always dark
  if (ver >= 7) for (const copy of versionPositions(size)) for (const [x, y] of copy) mark(x, y);
  functionCache.set(ver, f);
  return f;
}

const positionCache = new Map();

/** Data module coordinates in placement order (the two-column zigzag from the bottom right), as [x, y]. */
export function dataPositions(ver) {
  if (positionCache.has(ver)) return positionCache.get(ver);
  const size = ver * 4 + 17, f = functionModules(ver), out = [];
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    const upward = ((right + 1) & 2) === 0;
    for (let v = 0; v < size; v++) {
      const y = upward ? size - 1 - v : v;
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        if (!f[y * size + x]) out.push([x, y]);
      }
    }
  }
  positionCache.set(ver, out);
  return out;
}

const popcount = (n) => { let c = 0; for (; n; n &= n - 1) c++; return c; };

/** The closest valid word, if within 3 bit errors. Returns its index or -1. */
function nearest(words, ...reads) {
  let best = -1, bestD = 4;
  for (const r of reads) {
    for (let i = 0; i < words.length; i++) {
      const d = popcount(words[i] ^ r);
      if (d < bestD) { bestD = d; best = i; }
    }
  }
  return best;
}

// ── Grid → text ─────────────────────────────────────────────────────────────

/**
 * Decodes a sampled module grid (Uint8Array, 1 = dark, indexed y * size + x).
 * Tries the mirror image too. Throws QRError; when the version information
 * disagrees with the grid size, the error carries `dim`, the size it implies.
 */
export function decodeGrid(grid, size) {
  // The timing patterns are a cheap test that this is a QR code at all.
  let wrong = 0;
  for (let i = 8; i < size - 8; i++) wrong += (grid[6 * size + i] ^ (i & 1 ? 0 : 1)) + (grid[i * size + 6] ^ (i & 1 ? 0 : 1));
  if (wrong > (size - 16) / 2) throw new QRError('No timing pattern');
  try {
    return decodeOriented(grid, size);
  } catch (e) {
    const t = new Uint8Array(grid.length);
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) t[x * size + y] = grid[y * size + x];
    try { return decodeOriented(t, size); } catch { throw e; }
  }
}

function decodeOriented(grid, size) {
  if ((size - 17) % 4 || size < 21 || size > 177) throw new QRError('Not a QR code size');
  let ver = (size - 17) / 4;
  const at = (x, y) => grid[y * size + x];
  const read = (positions) => positions.reduce((n, [x, y], i) => n | (at(x, y) << i), 0);

  if (ver >= 7) {
    const [a, b] = versionPositions(size);
    const v = nearest(VERSION_WORDS.slice(7), read(a), read(b));
    if (v >= 0 && v + 7 !== ver) {
      const e = new QRError('Version information disagrees with the size');
      e.dim = (v + 7) * 4 + 17;
      throw e;
    }
  }
  const [fa, fb] = formatPositions(size);
  const fmt = nearest(FORMAT_WORDS, read(fa), read(fb));
  if (fmt < 0) throw new QRError('Unreadable format information');
  const level = LEVEL_FROM_FORMAT[fmt >> 3], mask = MASKS[fmt & 7];

  const L = blockLayout(ver, level);
  const raw = new Uint8Array(L.total);
  let i = 0;
  for (const [x, y] of dataPositions(ver)) {
    if (i >= L.total * 8) break;
    if (at(x, y) ^ mask(x, y)) raw[i >> 3] |= 0x80 >> (i & 7);
    i++;
  }

  // De-interleave: data codewords round-robin (short blocks end one early), then ECC.
  const blocks = Array.from({ length: L.blocks }, (_, j) => new Uint8Array(L.shortLen + (j < L.short ? 0 : 1)));
  let k = 0;
  const shortData = L.shortLen - L.ecc;
  for (let n = 0; n <= L.shortLen; n++) {
    for (let j = 0; j < L.blocks; j++) {
      if (n === shortData && j < L.short) continue;
      const idx = n > shortData && j < L.short ? n - 1 : n;
      blocks[j][idx] = raw[k++];
    }
  }
  const data = [];
  for (const b of blocks) {
    if (!rsCorrect(b, L.ecc)) throw new QRError('Too damaged to read');
    for (let n = 0; n < b.length - L.ecc; n++) data.push(b[n]);
  }
  return segments(Uint8Array.from(data), ver);
}

// ── Reed–Solomon over GF(256), x^8 + x^4 + x^3 + x^2 + 1 ───────────────────

const EXP = new Uint8Array(512), LOG = new Uint8Array(256);
for (let i = 0, x = 1; i < 255; i++) {
  EXP[i] = x; LOG[x] = i;
  x <<= 1;
  if (x & 0x100) x ^= 0x11d;
}
for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
const mul = (a, b) => (a && b ? EXP[LOG[a] + LOG[b]] : 0);
const div = (a, b) => (a ? EXP[LOG[a] + 255 - LOG[b]] : 0);

/** Corrects `block` (data then `ecc` check codewords) in place. Returns false if it can't. */
export function rsCorrect(block, ecc) {
  const n = block.length;
  const S = new Uint8Array(ecc);
  let any = 0;
  for (let i = 0; i < ecc; i++) {
    let s = 0;
    for (let j = 0; j < n; j++) s = mul(s, EXP[i]) ^ block[j];
    S[i] = s;
    any |= s;
  }
  if (!any) return true;

  // Berlekamp–Massey: the error locator Λ (coefficients low degree first).
  let C = [1], B = [1], L = 0, m = 1, b = 1;
  for (let k = 0; k < ecc; k++) {
    let d = S[k];
    for (let i = 1; i <= L; i++) d ^= mul(C[i] ?? 0, S[k - i]);
    if (d === 0) { m++; continue; }
    const T = C.slice(), coef = div(d, b);
    while (C.length < B.length + m) C.push(0);
    for (let i = 0; i < B.length; i++) C[i + m] ^= mul(coef, B[i]);
    if (2 * L <= k) { L = k + 1 - L; B = T; b = d; m = 1; } else m++;
  }
  if (2 * L > ecc) return false;

  // Chien search: position p (from the end) is in error where Λ(α^-p) = 0.
  const errs = [];
  for (let p = 0; p < n; p++) {
    const xinv = EXP[(255 - p) % 255];
    let v = 0;
    for (let j = C.length - 1; j >= 0; j--) v = mul(v, xinv) ^ C[j];
    if (v === 0) errs.push(p);
  }
  if (errs.length !== L) return false;

  // Forney: Ω = S·Λ mod x^ecc; magnitude = X·Ω(X^-1) / Λ'(X^-1).
  const O = new Uint8Array(ecc);
  for (let i = 0; i < ecc; i++) for (let j = 0; j < C.length && i + j < ecc; j++) O[i + j] ^= mul(S[i], C[j]);
  for (const p of errs) {
    const X = EXP[p], xinv = EXP[(255 - p) % 255];
    let om = 0;
    for (let j = ecc - 1; j >= 0; j--) om = mul(om, xinv) ^ O[j];
    let dl = 0, xp = 1; // Λ'(x) keeps the odd terms: Σ C[j] x^(j-1)
    for (let j = 1; j < C.length; j++) {
      if (j & 1) dl ^= mul(C[j], xp);
      xp = mul(xp, xinv);
    }
    if (!dl) return false;
    block[n - 1 - p] ^= mul(X, div(om, dl));
  }
  for (let i = 0; i < ecc; i++) {
    let s = 0;
    for (let j = 0; j < n; j++) s = mul(s, EXP[i]) ^ block[j];
    if (s) return false;
  }
  return true;
}

// ── Segments ────────────────────────────────────────────────────────────────

const ALNUM = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:';

function segments(data, ver) {
  let pos = 0;
  const left = () => data.length * 8 - pos;
  const bits = (n) => {
    if (n > left()) throw new QRError('Data ends early');
    let v = 0;
    for (let i = 0; i < n; i++, pos++) v = (v << 1) | ((data[pos >> 3] >> (7 - (pos & 7))) & 1);
    return v;
  };
  const size = ver < 10 ? 0 : ver < 27 ? 1 : 2;
  let out = '', eci = null;
  while (left() >= 4) {
    const mode = bits(4);
    if (mode === 0) break;
    if (mode === 1) { // numeric
      let n = bits([10, 12, 14][size]);
      for (; n >= 3; n -= 3) { const v = bits(10); if (v > 999) throw new QRError('Bad numeric data'); out += String(v).padStart(3, '0'); }
      if (n === 2) { const v = bits(7); if (v > 99) throw new QRError('Bad numeric data'); out += String(v).padStart(2, '0'); }
      if (n === 1) { const v = bits(4); if (v > 9) throw new QRError('Bad numeric data'); out += v; }
    } else if (mode === 2) { // alphanumeric
      let n = bits([9, 11, 13][size]);
      for (; n >= 2; n -= 2) { const v = bits(11); if (v >= 45 * 45) throw new QRError('Bad alphanumeric data'); out += ALNUM[Math.floor(v / 45)] + ALNUM[v % 45]; }
      if (n) { const v = bits(6); if (v >= 45) throw new QRError('Bad alphanumeric data'); out += ALNUM[v]; }
    } else if (mode === 4) { // bytes
      const n = bits([8, 16, 16][size]);
      const b = new Uint8Array(n);
      for (let i = 0; i < n; i++) b[i] = bits(8);
      out += text(b, eci);
    } else if (mode === 8) { // kanji, as Shift JIS
      const n = bits([8, 10, 12][size]);
      const b = new Uint8Array(n * 2);
      for (let i = 0; i < n; i++) {
        const v = bits(13);
        let c = ((Math.floor(v / 0xc0)) << 8) | (v % 0xc0);
        c += c < 0x1f00 ? 0x8140 : 0xc140;
        b[2 * i] = c >> 8; b[2 * i + 1] = c & 0xff;
      }
      let sjis;
      try { sjis = new TextDecoder('shift_jis'); } catch { throw new QRError('This browser can’t read Kanji QR codes'); }
      out += sjis.decode(b);
    } else if (mode === 7) { // ECI
      const first = bits(8);
      eci = (first & 0x80) === 0 ? first : (first & 0xc0) === 0x80 ? ((first & 0x3f) << 8) | bits(8) : ((first & 0x1f) << 16) | bits(16);
    } else if (mode === 3) { // structured append: this symbol stands alone for our purposes
      bits(16);
    } else if (mode === 5) { // FNC1, first position
    } else if (mode === 9) { // FNC1, second position
      bits(8);
    } else {
      throw new QRError('Unknown segment mode');
    }
  }
  return out;
}

/** Byte segments: UTF-8 unless an ECI says Latin-1; malformed UTF-8 falls back to Latin-1. */
function text(bytes, eci) {
  if (eci === 1 || eci === 3) return new TextDecoder('latin1').decode(bytes);
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return new TextDecoder('latin1').decode(bytes); }
}
