// ML-KEM-768 (FIPS 203). Zero dependencies.
//
//   keygen(seed64)       → { ek: 1184 B, dk: 2400 B }   seed64 = d ‖ z (Go's NewDecapsulationKey768 seed)
//   encaps(ek, m32?)     → { ct: 1088 B, ss: 32 B }     m32 given = deterministic Encaps_internal (tests only)
//   decaps(dk, ct)       → ss: 32 B                     implicit rejection on invalid ciphertexts
//
// Polynomials are Uint16Array(256) with coefficients always reduced to [0, q).
// Arithmetic uses plain JS numbers: every intermediate stays below 2^53.
//
// Timing: no branches or memory indices depend on secret data, except where
// FIPS 203 rejection-samples public data (SampleNTT). Division by q in
// Compress uses floating-point division, which modern CPUs execute in constant
// time (avoiding the integer-division leak known as KyberSlash). JS gives no
// hard constant-time guarantees; this is best effort.

import { sha3_256, sha3_512, shake256, Keccak } from './sha3.js';

const N = 256, Q = 3329, K = 3, ETA1 = 2, ETA2 = 2, DU = 10, DV = 4;
export const EK_BYTES = 384 * K + 32;                  // 1184
export const DK_BYTES = 768 * K + 96;                  // 2400
export const CT_BYTES = 32 * (DU * K + DV);            // 1088
export const SEED_BYTES = 64;

// ζ^BitRev7(i) for NTT, and ζ^(2·BitRev7(i)+1) for base-case multiplication.
const bitrev7 = (i) => parseInt(i.toString(2).padStart(7, '0').split('').reverse().join(''), 2);
const powmod = (b, e) => { let r = 1; for (; e; e--) r = (r * b) % Q; return r; };
const ZETAS = Uint16Array.from({ length: 128 }, (_, i) => powmod(17, bitrev7(i)));
const GAMMAS = Uint16Array.from({ length: 128 }, (_, i) => powmod(17, 2 * bitrev7(i) + 1));

const poly = () => new Uint16Array(N);
const mod = (x) => ((x % Q) + Q) % Q;

// ── NTT (FIPS 203 Algorithms 9–12) ──────────────────────────────────────────

function ntt(f) {
  const a = Uint16Array.from(f);
  let i = 1;
  for (let len = 128; len >= 2; len >>= 1) {
    for (let start = 0; start < N; start += 2 * len) {
      const zeta = ZETAS[i++];
      for (let j = start; j < start + len; j++) {
        const t = (zeta * a[j + len]) % Q;
        a[j + len] = (a[j] - t + Q) % Q;
        a[j] = (a[j] + t) % Q;
      }
    }
  }
  return a;
}

function invNtt(f) {
  const a = Uint16Array.from(f);
  let i = 127;
  for (let len = 2; len <= 128; len <<= 1) {
    for (let start = 0; start < N; start += 2 * len) {
      const zeta = ZETAS[i--];
      for (let j = start; j < start + len; j++) {
        const t = a[j];
        a[j] = (t + a[j + len]) % Q;
        a[j + len] = (zeta * (a[j + len] - t + Q)) % Q;
      }
    }
  }
  for (let j = 0; j < N; j++) a[j] = (a[j] * 3303) % Q;
  return a;
}

function mulNtt(f, g) {
  const h = poly();
  for (let i = 0; i < 128; i++) {
    const a0 = f[2 * i], a1 = f[2 * i + 1], b0 = g[2 * i], b1 = g[2 * i + 1];
    h[2 * i] = (a0 * b0 + ((a1 * b1) % Q) * GAMMAS[i]) % Q;
    h[2 * i + 1] = (a0 * b1 + a1 * b0) % Q;
  }
  return h;
}

function add(f, g) {
  const h = poly();
  for (let i = 0; i < N; i++) h[i] = (f[i] + g[i]) % Q;
  return h;
}

function sub(f, g) {
  const h = poly();
  for (let i = 0; i < N; i++) h[i] = (f[i] - g[i] + Q) % Q;
  return h;
}

// ── Sampling (Algorithms 7–8) ───────────────────────────────────────────────

function sampleNtt(rho, j, i) {
  const xof = Keccak.shake128().update(rho).update(new Uint8Array([j, i]));
  const a = poly();
  let n = 0;
  while (n < N) {
    const buf = xof.read(168);
    for (let p = 0; p < 168 && n < N; p += 3) {
      const d1 = buf[p] | ((buf[p + 1] & 0x0f) << 8);
      const d2 = (buf[p + 1] >> 4) | (buf[p + 2] << 4);
      if (d1 < Q) a[n++] = d1;
      if (d2 < Q && n < N) a[n++] = d2;
    }
  }
  return a;
}

// η = 2 only: each byte yields two coefficients from its two nibbles.
function sampleCbd2(bytes) {
  const f = poly();
  for (let i = 0; i < 128; i++) {
    const b = bytes[i];
    for (let h = 0; h < 2; h++) {
      const nib = b >> (4 * h);
      const x = (nib & 1) + ((nib >> 1) & 1);
      const y = ((nib >> 2) & 1) + ((nib >> 3) & 1);
      f[2 * i + h] = (x - y + Q) % Q;
    }
  }
  return f;
}

const prf = (s, b) => shake256(concat(s, new Uint8Array([b])), 64 * ETA1);

function matrix(rho) {
  // Â[i][j] = SampleNTT(ρ ‖ j ‖ i)
  return Array.from({ length: K }, (_, i) => Array.from({ length: K }, (_, j) => sampleNtt(rho, j, i)));
}

// ── Encoding and compression (Algorithms 5–6, §4.2.1) ───────────────────────

function byteEncode(polys, d) {
  const out = new Uint8Array(32 * d * polys.length);
  let o = 0, acc = 0, bits = 0;
  for (const f of polys) {
    for (let i = 0; i < N; i++) {
      acc |= f[i] << bits; bits += d;
      while (bits >= 8) { out[o++] = acc & 0xff; acc >>>= 8; bits -= 8; }
    }
  }
  return out;
}

function byteDecode(bytes, d, count) {
  const polys = [];
  const mask = (1 << d) - 1;
  let p = 0, acc = 0, bits = 0;
  for (let k = 0; k < count; k++) {
    const f = poly();
    for (let i = 0; i < N; i++) {
      while (bits < d) { acc |= bytes[p++] << bits; bits += 8; }
      const v = acc & mask;
      f[i] = d === 12 ? v % Q : v;
      acc >>>= d; bits -= d;
    }
    polys.push(f);
  }
  return polys;
}

function compress(f, d) {
  const g = poly();
  const m = 1 << d;
  for (let i = 0; i < N; i++) g[i] = Math.floor((f[i] * m + 1664) / Q) & (m - 1);
  return g;
}

function decompress(f, d) {
  const g = poly();
  const half = 1 << (d - 1);
  for (let i = 0; i < N; i++) g[i] = (f[i] * Q + half) >>> d;
  return g;
}

// ── K-PKE (Algorithms 13–15) ────────────────────────────────────────────────

function pkeKeygen(d) {
  const g = sha3_512(concat(d, new Uint8Array([K])));
  const rho = g.subarray(0, 32), sigma = g.subarray(32);
  const A = matrix(rho);
  let n = 0;
  const s = Array.from({ length: K }, () => ntt(sampleCbd2(prf(sigma, n++))));
  const e = Array.from({ length: K }, () => ntt(sampleCbd2(prf(sigma, n++))));
  const t = A.map((row, i) => row.reduce((acc, a, j) => add(acc, mulNtt(a, s[j])), e[i]));
  return { ek: concat(byteEncode(t, 12), rho), dk: byteEncode(s, 12) };
}

function pkeEncrypt(ek, m, r) {
  const t = byteDecode(ek, 12, K);
  const rho = ek.subarray(384 * K);
  const A = matrix(rho);
  let n = 0;
  const y = Array.from({ length: K }, () => ntt(sampleCbd2(prf(r, n++))));
  const e1 = Array.from({ length: K }, () => sampleCbd2(prf(r, n++)));
  const e2 = sampleCbd2(prf(r, n));
  const u = Array.from({ length: K }, (_, i) =>
    add(invNtt(y.reduce((acc, yj, j) => add(acc, mulNtt(A[j][i], yj)), poly())), e1[i]));
  const mu = decompress(byteDecode(m, 1, 1)[0], 1);
  const v = add(add(invNtt(t.reduce((acc, tj, j) => add(acc, mulNtt(tj, y[j])), poly())), e2), mu);
  return concat(byteEncode(u.map((p) => compress(p, DU)), DU), byteEncode([compress(v, DV)], DV));
}

function pkeDecrypt(dk, c) {
  const u = byteDecode(c, DU, K).map((p) => ntt(decompress(p, DU)));
  const v = decompress(byteDecode(c.subarray(32 * DU * K), DV, 1)[0], DV);
  const s = byteDecode(dk, 12, K);
  const w = sub(v, invNtt(s.reduce((acc, sj, j) => add(acc, mulNtt(sj, u[j])), poly())));
  return byteEncode([compress(w, 1)], 1);
}

// ── ML-KEM (Algorithms 16–21) ───────────────────────────────────────────────

/** FIPS 203 §7.2 modulus check: every encoded coefficient of ek must be < q. */
export function checkEncapsulationKey(ek) {
  if (!(ek instanceof Uint8Array) || ek.length !== EK_BYTES) return false;
  const tBytes = ek.subarray(0, 384 * K);
  return bytesEqual(byteEncode(byteDecode(tBytes, 12, K), 12), tBytes);
}

/** FIPS 203 §7.3 hash check: H(ek) stored in dk must match the embedded ek. */
export function checkDecapsulationKey(dk) {
  if (!(dk instanceof Uint8Array) || dk.length !== DK_BYTES) return false;
  return bytesEqual(sha3_256(dk.subarray(384 * K, 768 * K + 32)), dk.subarray(768 * K + 32, 768 * K + 64));
}

export function keygen(seed) {
  if (!(seed instanceof Uint8Array) || seed.length !== SEED_BYTES) throw new Error('mlkem: seed must be 64 bytes');
  const d = seed.subarray(0, 32), z = seed.subarray(32);
  const { ek, dk: dkPke } = pkeKeygen(d);
  return { ek, dk: concat(dkPke, ek, sha3_256(ek), z) };
}

export function encaps(ek, m) {
  if (!checkEncapsulationKey(ek)) throw new Error('mlkem: invalid encapsulation key');
  if (m === undefined) m = crypto.getRandomValues(new Uint8Array(32));
  else if (!(m instanceof Uint8Array) || m.length !== 32) throw new Error('mlkem: m must be 32 bytes');
  const g = sha3_512(concat(m, sha3_256(ek)));
  const ss = g.slice(0, 32), r = g.subarray(32);
  return { ct: pkeEncrypt(ek, m, r), ss };
}

export function decaps(dk, ct) {
  if (!(ct instanceof Uint8Array) || ct.length !== CT_BYTES) throw new Error('mlkem: ciphertext must be 1088 bytes');
  if (!checkDecapsulationKey(dk)) throw new Error('mlkem: invalid decapsulation key');
  const dkPke = dk.subarray(0, 384 * K);
  const ekPke = dk.subarray(384 * K, 768 * K + 32);
  const h = dk.subarray(768 * K + 32, 768 * K + 64);
  const z = dk.subarray(768 * K + 64);
  const m = pkeDecrypt(dkPke, ct);
  const g = sha3_512(concat(m, h));
  const kGood = g.subarray(0, 32), r = g.subarray(32);
  const kBad = shake256(concat(z, ct), 32);
  const ct2 = pkeEncrypt(ekPke, m, r);
  // Constant-time select: mask = 0xff if ct == ct2, else 0x00.
  let diff = 0;
  for (let i = 0; i < CT_BYTES; i++) diff |= ct[i] ^ ct2[i];
  const mask = ((diff - 1) >> 8) & 0xff;
  const ss = new Uint8Array(32);
  for (let i = 0; i < 32; i++) ss[i] = (kGood[i] & mask) | (kBad[i] & ~mask);
  return ss;
}

// ── helpers ─────────────────────────────────────────────────────────────────

function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

function bytesEqual(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}
