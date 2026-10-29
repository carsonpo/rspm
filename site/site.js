// reallysimplepasswordmanager.com — the public-bucket wall, the live encryption
// demo, and scroll reveals. Plain DOM; never assigns markup strings.

// Set once the repository is public.
const REPO = 'https://github.com/carsonpo/rspm';

const $ = (s, el = document) => el.querySelector(s);
const reduced = matchMedia('(prefers-reduced-motion: reduce)');
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const B32 = 'abcdefghijklmnopqrstuvwxyz234567';

document.documentElement.classList.add('js');

for (const a of document.querySelectorAll('[data-repo]')) {
  const sub = a.getAttribute('data-repo');
  a.href = sub ? `${REPO}/blob/main/${sub}` : REPO;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function hexColor(h) {
  const m = /^#?([0-9a-f]{6})$/i.exec(h);
  const n = m ? parseInt(m[1], 16) : 0;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

const mix = (a, b, t) => [0, 1, 2].map((i) => Math.round(a[i] + (b[i] - a[i]) * t));

/** Deterministic pseudo-random bytes for a tile index (xorshift; purely visual). */
function tileBytes(seed, n) {
  let x = (seed * 2654435761) >>> 0 || 1;
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; out[i] = x & 255; }
  return out;
}

// ── The public bucket ───────────────────────────────────────────────────────

function bucket() {
  const canvas = $('.bucket-canvas');
  const tipPath = $('.bucket-tip-path');
  const tipMeta = $('.bucket-tip-meta');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const TILE = 22, GAP = 5, SUB = 4;
  const NIGHT = [14, 16, 15], LINE = [38, 42, 40], GLOW = [95, 208, 179];
  let cols = 0, rows = 0, dpr = 1, tiles = [], hover = -1, raf = 0, last = 0;
  const off = document.createElement('canvas');
  const octx = off.getContext('2d');

  function paintTile(i) {
    const t = tiles[i];
    const x = (i % cols) * (TILE + GAP) + GAP, y = Math.floor(i / cols) * (TILE + GAP) + GAP;
    octx.clearRect(x * dpr, y * dpr, TILE * dpr, TILE * dpr);
    if (!t.alive) {
      octx.strokeStyle = `rgb(${LINE})`;
      octx.lineWidth = dpr;
      octx.setLineDash([2 * dpr, 2 * dpr]);
      octx.strokeRect((x + 0.5) * dpr, (y + 0.5) * dpr, (TILE - 1) * dpr, (TILE - 1) * dpr);
      octx.setLineDash([]);
      return;
    }
    const bytes = tileBytes(t.seed, SUB * SUB);
    const s = TILE / SUB;
    for (let k = 0; k < SUB * SUB; k++) {
      const v = bytes[k] / 255;
      const c = mix(mix(NIGHT, [72, 80, 76], 0.25 + v * 0.75), GLOW, v > 0.86 ? 0.35 : 0.06);
      octx.fillStyle = `rgb(${c})`;
      octx.fillRect((x + (k % SUB) * s) * dpr, (y + Math.floor(k / SUB) * s) * dpr, Math.ceil(s * dpr), Math.ceil(s * dpr));
    }
  }

  function layout() {
    const r = canvas.getBoundingClientRect();
    dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = off.width = Math.round(r.width * dpr);
    canvas.height = off.height = Math.round(r.height * dpr);
    cols = Math.max(1, Math.floor((r.width - GAP) / (TILE + GAP)));
    rows = Math.max(1, Math.floor((r.height - GAP) / (TILE + GAP)));
    tiles = Array.from({ length: cols * rows }, (_, i) => ({ seed: (i + 1) * 7919, alive: Math.random() > 0.08, flash: 0 }));
    tiles.forEach((_, i) => paintTile(i));
    draw();
    describe(Math.floor(tiles.length / 3));
  }

  function draw() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    // centre the wall
    const w = cols * (TILE + GAP) + GAP, h = rows * (TILE + GAP) + GAP;
    const ox = Math.floor((canvas.width / dpr - w) / 2), oy = Math.floor((canvas.height / dpr - h) / 2);
    ctx.drawImage(off, ox * dpr, oy * dpr);
    tiles.forEach((t, i) => {
      if (t.flash <= 0 && i !== hover) return;
      const x = ox + (i % cols) * (TILE + GAP) + GAP, y = oy + Math.floor(i / cols) * (TILE + GAP) + GAP;
      const a = i === hover ? 1 : t.flash;
      ctx.strokeStyle = `rgba(${GLOW}, ${a})`;
      ctx.lineWidth = 1.5 * dpr;
      ctx.strokeRect((x - 1.5) * dpr, (y - 1.5) * dpr, (TILE + 3) * dpr, (TILE + 3) * dpr);
      if (t.flash > 0) { ctx.fillStyle = `rgba(${GLOW}, ${t.flash * 0.25})`; ctx.fillRect(x * dpr, y * dpr, TILE * dpr, TILE * dpr); }
    });
    canvas.dataset.ox = ox;
    canvas.dataset.oy = oy;
  }

  function describe(i) {
    const t = tiles[i];
    if (!t) return;
    const b = tileBytes(t.seed ^ 0x5bd1e995, 26);
    tipPath.textContent = t.alive ? `b/${Array.from(b, (x) => B32[x & 31]).join('')}` : 'b/·························· (deleted)';
    tipMeta.textContent = t.alive ? `4,096 bytes · owner unknown · contents unknown` : 'Superseded by a newer generation and removed';
  }

  function tick(now) {
    raf = requestAnimationFrame(tick);
    if (now - last < 90) return;
    const dt = now - last;
    last = now;
    let dirty = false;
    for (const t of tiles) if (t.flash > 0) { t.flash = Math.max(0, t.flash - dt / 900); dirty = true; }
    // A save writes a new generation and deletes the old one.
    if (Math.random() < 0.55) {
      const i = Math.floor(Math.random() * tiles.length);
      const t = tiles[i];
      if (t.alive && Math.random() < 0.35) { t.alive = false; }
      else { t.alive = true; t.seed = (Math.random() * 2 ** 31) | 0; t.flash = 1; }
      paintTile(i);
      if (i === hover) describe(i);
      dirty = true;
    }
    if (dirty) draw();
  }

  canvas.addEventListener('pointermove', (e) => {
    const r = canvas.getBoundingClientRect();
    const x = e.clientX - r.left - Number(canvas.dataset.ox), y = e.clientY - r.top - Number(canvas.dataset.oy);
    const c = Math.floor((x - GAP / 2) / (TILE + GAP)), rr = Math.floor((y - GAP / 2) / (TILE + GAP));
    const i = c >= 0 && c < cols && rr >= 0 && rr < rows ? rr * cols + c : -1;
    if (i !== hover) { hover = i; if (i >= 0) describe(i); draw(); }
  });
  canvas.addEventListener('pointerleave', () => { hover = -1; draw(); });

  new ResizeObserver(() => layout()).observe(canvas);
  const run = () => { cancelAnimationFrame(raf); if (!reduced.matches) raf = requestAnimationFrame(tick); };
  reduced.addEventListener('change', run);
  run();
}

// ── Live encryption demo ────────────────────────────────────────────────────

async function demo() {
  const input = $('#secret');
  if (!input || !crypto.subtle) return;
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt']);
  const enc = new TextEncoder();
  let latest = 0;

  function draw(canvas, bytes, { plain }) {
    const ctx = canvas.getContext('2d');
    const img = ctx.createImageData(64, 64);
    const bg = hexColor(css('--paper-2'));
    const fg = hexColor(css(plain ? '--ink' : '--accent'));
    const ink = hexColor(css('--ink'));
    for (let i = 0; i < 4096; i++) {
      const b = i < bytes.length ? bytes[i] : 0;
      const c = plain
        ? (b === 0 ? bg : mix(bg, fg, 0.35 + (b / 255) * 0.65))
        : mix(mix(bg, ink, 0.08 + (b / 255) * 0.55), fg, (b & 7) / 18);
      img.data.set([...c, i < bytes.length || plain ? 255 : 0], i * 4);
    }
    ctx.putImageData(img, 0, 0);
  }

  function dump(pre, bytes, rows = 6) {
    const frag = document.createDocumentFragment();
    for (let r = 0; r < rows; r++) {
      const line = document.createElement('div');
      line.append(document.createTextNode(`${(r * 16).toString(16).padStart(4, '0')}  `));
      for (let c = 0; c < 16; c++) {
        const b = bytes[r * 16 + c] ?? 0;
        const s = b.toString(16).padStart(2, '0') + (c === 7 ? '  ' : ' ');
        if (b) { const e = document.createElement('b'); e.textContent = s; line.append(e); }
        else line.append(document.createTextNode(s));
      }
      frag.append(line);
    }
    const tail = document.createElement('div');
    tail.textContent = `…  ${(4096 - rows * 16).toLocaleString()} more bytes`;
    frag.append(tail);
    pre.replaceChildren(frag);
  }

  async function seal() {
    const mine = ++latest;
    const payload = enc.encode(input.value).slice(0, 4064);
    const pt = new Uint8Array(4067);
    pt[0] = 0x02; // data chunk
    pt[1] = payload.length >> 8;
    pt[2] = payload.length & 255;
    pt.set(payload, 3);
    const nonce = crypto.getRandomValues(new Uint8Array(12));
    const locator = crypto.getRandomValues(new Uint8Array(16));
    const aad = new Uint8Array([...enc.encode('rspm/v1/block'), ...locator]);
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: aad }, key, pt));
    if (mine !== latest) return;
    const block = new Uint8Array(4096);
    block[0] = 0x01;
    block.set(nonce, 1);
    block.set(ct, 13);
    draw($('#plain'), pt, { plain: true });
    draw($('#cipher'), block, { plain: false });
    dump($('#plain-hex'), pt);
    dump($('#cipher-hex'), block);
  }

  input.addEventListener('input', seal);
  $('#reseal').addEventListener('click', seal);
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', seal);
  seal();
}

// ── Reveal on scroll ────────────────────────────────────────────────────────

function reveal() {
  const els = document.querySelectorAll('.hero-copy, .bucket, .section-head, .demo-input, .demo-grid, .cards, .flow-step, .dev > *, .share-grid > *, .limits, .verify, .source > *');
  if (!('IntersectionObserver' in window)) return;
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); }
  }, { rootMargin: '0px 0px -8% 0px', threshold: 0.08 });
  els.forEach((el, i) => {
    el.classList.add('reveal');
    if (el.classList.contains('flow-step')) el.style.transitionDelay = `${(i % 4) * 90}ms`;
    io.observe(el);
  });
}

bucket();
demo();
reveal();
