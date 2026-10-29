import { readFileSync } from 'node:fs';
import { scan, decodeGrid, rsCorrect } from '../core/qr.js';
import { parseMigration, parseOtpauth, encodeSecret, decodeSecret } from '../core/totp.js';
import { encode, fillVersion, render, placed, prng, rsEncode, migrationUri } from './qr-encode.js';
import { eq, ok, throws } from '../tools/check.js';

const LEVELS = ['L', 'M', 'Q', 'H'];
const URI = 'otpauth://totp/GitHub:octocat?secret=ABCDEFGHIJKLMNOPQRSTUVWXYZ234567&issuer=GitHub&algorithm=SHA1&digits=6&period=30';

// ── Grid decoding ───────────────────────────────────────────────────────────

export function everyVersionLevelAndMask() {
  for (let v = 1; v <= 40; v++) {
    for (const [li, level] of LEVELS.entries()) {
      const mask = (v * 4 + li) % 8;
      // Fill the version: every data and check codeword is exercised.
      const text = fillVersion(v, level, `v${v}${level}:`, 'é·x');
      const q = encode(text, { level, version: v, mask });
      eq(decodeGrid(q.modules, q.size), text, `version ${v}-${level} mask ${mask}`);
    }
  }
  for (const v of [1, 7]) for (let mask = 0; mask < 8; mask++) {
    const q = encode('mask test', { level: 'Q', version: v, mask });
    eq(decodeGrid(q.modules, q.size), 'mask test', `version ${v} mask ${mask}`);
  }
}

const hasShiftJis = (() => { try { new TextDecoder('shift_jis'); return true; } catch { return false; } })();

export function everySegmentMode() {
  // Bun has no Shift JIS decoder; browsers and Node do.
  if (!hasShiftJis) console.log('        (Kanji skipped: this runtime has no Shift JIS decoder)');
  const segs = [
    { numeric: '0123456789012' }, { alnum: 'HELLO WORLD $%*+-./:' }, { byte: 'otpauth://totp/x?secret=AB' },
    { eci: 26 }, { byte: 'zürich ✓' }, hasShiftJis ? { kanji: [0x935f, 0xe4aa] } : { byte: '点茗' }, { eci: 3 }, { byte: Uint8Array.of(0x63, 0x61, 0x66, 0xe9) },
  ];
  for (const v of [5, 10, 27]) {
    const q = encode(segs, { level: 'L', version: v, mask: 2 });
    eq(decodeGrid(q.modules, q.size), '0123456789012HELLO WORLD $%*+-./:otpauth://totp/x?secret=ABzürich ✓点茗café', `version ${v} (count field sizes)`);
  }
}

export function reedSolomonCorrectsUpToCapacity() {
  const r = prng(11);
  for (const ecc of [7, 10, 16, 22, 30]) {
    for (let trial = 0; trial < 20; trial++) {
      const data = Uint8Array.from({ length: 20 + Math.floor(r() * 100) }, () => Math.floor(r() * 256));
      const block = rsEncode(data, ecc);
      const errors = Math.floor(r() * (Math.floor(ecc / 2) + 1));
      const where = new Set();
      while (where.size < errors) where.add(Math.floor(r() * block.length));
      for (const i of where) block[i] ^= 1 + Math.floor(r() * 255);
      ok(rsCorrect(block, ecc), `${errors} errors with ${ecc} check codewords`);
      eq(block.slice(0, data.length), data);
    }
  }
}

export function damagedAndMirroredGrids() {
  const q = encode(URI, { level: 'H', mask: 4 });
  const r = prng(5);
  const damaged = q.modules.slice();
  // A smudge over the middle: H recovers about 30%.
  const c = q.size >> 1;
  for (let y = c - 4; y < c + 4; y++) for (let x = c - 4; x < c + 4; x++) damaged[y * q.size + x] = r() < 0.5 ? 1 : 0;
  eq(decodeGrid(damaged, q.size), URI);

  const mirrored = new Uint8Array(q.modules.length);
  for (let y = 0; y < q.size; y++) for (let x = 0; x < q.size; x++) mirrored[x * q.size + y] = q.modules[y * q.size + x];
  eq(decodeGrid(mirrored, q.size), URI, 'a code seen from behind (mirrored)');

  throws(() => decodeGrid(new Uint8Array(q.size * q.size), q.size), /timing/i);
}

/** Codes from an independent encoder, github.com/skip2/go-qrcode (test/gen/qr.go). */
export function referenceVectors() {
  const cases = JSON.parse(readFileSync(new URL('./vectors/qr.json', import.meta.url), 'utf8'));
  ok(cases.length >= 100);
  for (const c of cases) {
    const grid = new Uint8Array(c.size * c.size);
    c.rows.forEach((hexRow, y) => {
      for (let x = 0; x < c.size; x++) grid[y * c.size + x] = (parseInt(hexRow.slice((x >> 3) * 2, (x >> 3) * 2 + 2), 16) >> (7 - (x & 7))) & 1;
    });
    eq(decodeGrid(grid, c.size), c.text, `version ${c.version}-${c.level}`);
  }
}

// ── Finding codes in images ─────────────────────────────────────────────────

export function scansCleanScreenshots() {
  for (const level of LEVELS) {
    const q = encode(URI, { level, mask: 3 });
    eq(scan(render(q, { scale: 6 })), URI, `level ${level}`);
    eq(scan(render(q, { scale: 2, quiet: 2 })), URI, `level ${level}, 2 px per module, narrow margin`);
  }
}

export function scansCameraLikeImages() {
  const W = 640, H = 480;
  for (const version of [undefined, 10, 20]) {
    const q = encode(URI, { level: 'M', version, mask: 5 });
    const scale = Math.max(2, Math.floor(300 / q.size));
    const at = (o) => ({ width: W, height: H, corners: placed(q.size, { scale, W, H, ...o }) });
    const r = prng(7);
    const cases = {
      rotated15: at({ deg: 15 }), rotated45: at({ deg: 45 }), rotated90: at({ deg: 90 }), upsideDown: at({ deg: 180 }), rotated250: at({ deg: 250 }),
      perspective: at({ squeeze: 0.2, deg: 10 }),
      blurred: { ...at({ deg: 7 }), blur: Math.max(1, scale >> 2) },
      noisy: { ...at({ deg: 3 }), noise: 60 },
      dimAndUneven: { ...at({ deg: 5 }), contrast: 0.4, gradient: 0.5, noise: 8 },
      lightOnDark: { ...at({ deg: 12 }), invert: true },
      busyBackground: { ...at({ deg: 8 }), background: (x, y) => (((x >> 4) + (y >> 3)) % 3 === 0 && r() < 0.6 ? 1 : 0) },
      small: { width: W, height: H, corners: placed(q.size, { scale: 1.6, W, H, deg: 4 }) },
    };
    if (q.size < 60) cases.steepPerspective = at({ squeeze: 0.35, deg: -20 });
    for (const [name, opts] of Object.entries(cases)) eq(scan(render(q, opts)), URI, `version ${q.version} ${name}`);
  }
}

export function scansTransparentImages() {
  // A PNG saved from a setup page: dark modules on a transparent background.
  const q = encode(URI, { level: 'M', mask: 1 });
  eq(scan(render(q, { scale: 5, transparent: true })), URI);
}

export function scansAPhoneScreenshot() {
  // A full-height phone screenshot with the code in the middle of other UI.
  const q = encode(URI, { level: 'M', mask: 6 });
  const W = 1179, H = 2556, s = 600;
  const x0 = (W - s) / 2, y0 = 900;
  const corners = [[x0, y0], [x0 + s, y0], [x0 + s, y0 + s], [x0, y0 + s]];
  const r = prng(9);
  const text = (x, y) => (y % 120 < 30 && y < 800 && (x >> 5) % 3 !== 2 && r() < 0.5 ? 1 : 0);
  eq(scan(render(q, { width: W, height: H, corners, background: text })), URI);
}

export function ignoresImagesWithoutCodes() {
  const W = 400, H = 300, r = prng(3);
  const noise = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < W * H; i++) { const v = r() < 0.5 ? 0 : 255; noise.set([v, v, v, 255], i * 4); }
  eq(scan({ data: noise, width: W, height: H }), null);
  eq(scan({ data: new Uint8ClampedArray(W * H * 4).fill(255), width: W, height: H }), null);
  const checker = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < W * H; i++) { const v = ((i % W >> 3) + (Math.floor(i / W) >> 3)) & 1 ? 0 : 255; checker.set([v, v, v, 255], i * 4); }
  eq(scan({ data: checker, width: W, height: H }), null);
  eq(scan({ data: new Uint8ClampedArray(4 * 4 * 4), width: 4, height: 4 }), null);
}

// ── Google Authenticator exports ────────────────────────────────────────────

export function googleAuthenticatorExport() {
  // The example from github.com/dim13/otpauth's README.
  const { accounts, skipped } = parseMigration('otpauth-migration://offline?data=CjEKCkhlbGxvId6tvu8SGEV4YW1wbGU6YWxpY2VAZ29vZ2xlLmNvbRoHRXhhbXBsZSABKAEwAhABGAEgACjr4JKK%2Bf%2F%2F%2F%2F8B');
  eq(skipped, 0);
  eq(accounts.length, 1);
  eq(accounts[0].issuer, 'Example');
  eq(accounts[0].account, 'alice@google.com');
  const p = parseOtpauth(accounts[0].uri);
  eq(encodeSecret(p.secret), 'JBSWY3DPEHPK3PXP');
  eq([p.issuer, p.account, p.algorithm, p.digits, p.period], ['Example', 'alice@google.com', 'SHA1', 6, 30]);
}

export function googleAuthenticatorBatch() {
  const utf8 = (x) => new TextEncoder().encode(x);
  const uri = migrationUri([
    { secret: utf8('12345678901234567890'), name: 'me@x.com', issuer: 'Bank & Co', algorithm: 2, digits: 2 }, // SHA256, 8 digits
    { secret: utf8('abcdefghij'), name: 'plain' },
    { secret: utf8('abcdefghij'), name: 'counter', issuer: 'Old', type: 1 }, // HOTP: skipped
  ]);
  const { accounts, skipped } = parseMigration(uri);
  eq(skipped, 1);
  eq(accounts.map((a) => [a.name, a.account]), [['Bank & Co', 'me@x.com'], ['plain', 'plain']]);
  const p = parseOtpauth(accounts[0].uri);
  eq([p.issuer, p.account, p.algorithm, p.digits], ['Bank & Co', 'me@x.com', 'SHA256', 8]);
  eq(encodeSecret(p.secret), encodeSecret(new TextEncoder().encode('12345678901234567890')));
  throws(() => parseMigration('otpauth://totp/x?secret=AB'), /Google Authenticator/);
  throws(() => parseMigration('otpauth-migration://offline?data=CgU'), /damaged/);
}

export function base32RoundTrip() {
  const r = prng(2);
  for (let n = 1; n < 40; n++) {
    const b = Uint8Array.from({ length: n }, () => Math.floor(r() * 256));
    eq(decodeSecret(encodeSecret(b)), b);
  }
}
