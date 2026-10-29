// Proof-of-work verification (PROTOCOL §9.2). WebCrypto only, so the worker
// can import it without the wasm loader.

import { b32decode, concat, utf8 } from './encoding.js';
import { sha256 } from './crypto.js';

export function powPrefix(ts, method, path, bodyHash) {
  return concat(utf8(`rspm/v1/pow${ts} ${method} ${path}`), bodyHash);
}

export function leadingZeroBits(digest) {
  let n = 0;
  for (const b of digest) {
    if (b === 0) { n += 8; continue; }
    return n + Math.clz32(b) - 24;
  }
  return n;
}

/** Verifies a PoW header. Returns true or false; never throws on bad input. */
export async function verify(header, { method, path, body, bits, now = Math.floor(Date.now() / 1000), skew = 300 }) {
  const m = /^(\d{1,12})\.([a-z2-7]{26})$/.exec(header ?? '');
  if (!m) return false;
  const ts = Number(m[1]);
  if (Math.abs(now - ts) > skew) return false;
  let nonce;
  try { nonce = b32decode(m[2]); } catch { return false; }
  if (nonce.length !== 16) return false;
  const digest = await sha256(powPrefix(ts, method, path, await sha256(body)), nonce);
  return leadingZeroBits(digest) >= bits;
}
