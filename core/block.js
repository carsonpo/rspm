// Locators and the 4096-byte block format (PROTOCOL §4).

import { b32, concat, u16be } from './encoding.js';
import { hmac, open, random, seal, sha256 } from './crypto.js';

export const BLOCK = 4096;
export const PLAINTEXT = 4067;
export const PAYLOAD_MAX = 4064;
export const VERSION = 0x01;

export const TYPE = Object.freeze({ HEAD: 0x01, DATA: 0x02, SHARE_HEAD: 0x11, SHARE_DATA: 0x12 });

/** Locator from a delete token (§4.2). */
export async function locatorFromToken(token) {
  const raw = (await sha256('rspm/v1/locator', token)).slice(0, 16);
  return { raw, id: b32(raw) };
}

/** { token, raw, id } for `label` under `key`. */
export async function locate(key, label) {
  const token = await hmac(key, label);
  return { token, ...(await locatorFromToken(token)) };
}

const aad = (raw) => concat(new TextEncoder().encode('rspm/v1/block'), raw);

export async function sealBlock(key, locatorRaw, type, payload) {
  if (payload.length > PAYLOAD_MAX) throw new Error(`block payload too large: ${payload.length}`);
  const pt = new Uint8Array(PLAINTEXT);
  pt[0] = type;
  pt.set(u16be(payload.length), 1);
  pt.set(payload, 3);
  const nonce = random(12);
  const ct = await seal(key, nonce, pt, aad(locatorRaw));
  const block = concat(new Uint8Array([VERSION]), nonce, ct);
  if (block.length !== BLOCK) throw new Error('internal: block size mismatch');
  return block;
}

/** { type, payload } or null if the block is malformed or fails authentication. */
export async function openBlock(key, locatorRaw, block) {
  if (!block || block.length !== BLOCK || block[0] !== VERSION) return null;
  const pt = await open(key, block.subarray(1, 13), block.subarray(13), aad(locatorRaw));
  if (!pt) return null;
  const len = (pt[1] << 8) | pt[2];
  if (len > PAYLOAD_MAX) return null;
  for (let i = 3 + len; i < pt.length; i++) if (pt[i]) return null;
  return { type: pt[0], payload: pt.slice(3, 3 + len) };
}

export function nextPow2(n) {
  let p = 1;
  while (p < n) p *= 2;
  return p;
}

/** Splits bytes into ≤PAYLOAD_MAX chunks padded with empty chunks to a power of two ≥ min. */
export function chunk(bytes, min) {
  const chunks = [];
  for (let i = 0; i < bytes.length; i += PAYLOAD_MAX) chunks.push(bytes.subarray(i, i + PAYLOAD_MAX));
  const n = Math.max(min, nextPow2(chunks.length));
  while (chunks.length < n) chunks.push(new Uint8Array(0));
  return chunks;
}
