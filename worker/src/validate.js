// Block validity checks (PROTOCOL §9.4).
//
// A genuine block is indistinguishable from random bytes, so this can never
// prove a block is real. It only rejects uploads that are *obviously* not
// ciphertext. Every check is here, in one function, so anyone can audit it.

import { b32 } from '../../core/encoding.js';
import { sha256, deflate } from '../../core/crypto.js';

export const BLOCK = 4096;
const PATH = /^(b\/[a-z2-7]{26}|e\/(\d{1,10})\/[a-z2-7]{26}|h\/[a-z2-7]{26})$/;
const CHI2_MAX = 400;          // 255 degrees of freedom; honest false-positive rate ≪ 1e-9
const DEFLATE_MIN_RATIO = 0.98; // random data does not compress

/** Parses an object path. Returns { prefix, hour? } or null. */
export function parsePath(path) {
  const m = PATH.exec(path);
  if (!m) return null;
  return { prefix: path[0], hour: m[2] === undefined ? undefined : Number(m[2]) };
}

export function chiSquare(bytes) {
  const counts = new Uint32Array(256);
  for (const b of bytes) counts[b]++;
  const expected = bytes.length / 256;
  let x = 0;
  for (const c of counts) x += (c - expected) ** 2 / expected;
  return x;
}

export async function deflatedSize(bytes) {
  return (await deflate(bytes)).length;
}

async function looksRandom(region) {
  if (chiSquare(region) > CHI2_MAX) return 'V4: byte distribution is not uniform';
  if ((await deflatedSize(region)) < region.length * DEFLATE_MIN_RATIO) return 'V3: content is compressible';
  return null;
}

/**
 * Returns null if `body` may be stored at `path`, otherwise a short reason.
 * `nowHour` bounds expiring paths (PROTOCOL §8).
 */
export async function validate(path, body, nowHour) {
  const p = parsePath(path);
  if (!p) return 'V2: invalid path';
  if (body.length !== BLOCK || body[0] !== 0x01) return 'V1: objects are exactly 4096 bytes and start with 0x01';
  if (p.prefix === 'e' && (p.hour <= nowHour || p.hour > nowHour + 720)) return 'expiry must be 1–720 hours from now';

  if (p.prefix === 'h') {
    if (new TextDecoder().decode(body.subarray(1, 7)) !== 'RSPMH1') return 'V5: bad handle record magic';
    const len = body[1255];
    if (len < 3 || len > 32) return 'V5: bad handle length';
    const handle = new TextDecoder().decode(body.subarray(1256, 1256 + len));
    if (!/^[a-z0-9_-]{3,32}$/.test(handle)) return 'V5: invalid handle';
    const expect = b32((await sha256('rspm/v1/handle', handle)).slice(0, 16));
    if (path !== `h/${expect}`) return 'V5: handle does not match path';
    return looksRandom(body.subarray(1256 + len));
  }
  return looksRandom(body.subarray(1));
}
