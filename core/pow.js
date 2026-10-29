// Proof-of-work (PROTOCOL §9.2).
//
//   digest = SHA-256("rspm/v1/pow" ‖ ts ‖ " " ‖ method ‖ " " ‖ path ‖ SHA-256(body) ‖ nonce)
//
// nonce is 16 bytes: 12 random bytes then a 4-byte big-endian counter that
// wasm/pow.wat searches over. Verification uses WebCrypto only.

import { b32, concat } from './encoding.js';
import { powPrefix, verify, leadingZeroBits } from './powcheck.js';
import { random, sha256 } from './crypto.js';
import { wasmInstance } from './wasm.js';

const MSG = 1024;
const CHUNK = 1 << 16;

export { verify, leadingZeroBits };

/** SHA-256 padding: returns the padded message as a multiple of 64 bytes. */
export function pad(msg) {
  const len = Math.ceil((msg.length + 9) / 64) * 64;
  const out = new Uint8Array(len);
  out.set(msg);
  out[msg.length] = 0x80;
  new DataView(out.buffer).setBigUint64(len - 8, BigInt(msg.length) * 8n);
  return out;
}

let instance;
async function pow() {
  instance ??= (await wasmInstance('pow')).exports;
  return instance;
}

function readDigest(exports) {
  const view = new DataView(exports.memory.buffer);
  const out = new Uint8Array(32);
  const dv = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) dv.setUint32(i * 4, view.getUint32(512 + i * 4, true));
  return out;
}

/** SHA-256 via the wasm module (used to test it against WebCrypto). */
export async function wasmSha256(msg) {
  const w = await pow();
  const padded = pad(msg);
  if (padded.length > w.memory.buffer.byteLength - MSG) throw new Error('message too long');
  new Uint8Array(w.memory.buffer).set(padded, MSG);
  w.digest(padded.length / 64);
  return readDigest(w);
}

/**
 * Finds a PoW header for a request. Yields to the event loop between chunks so
 * a UI stays responsive.
 */
export async function solve({ method, path, body, bits, now = Math.floor(Date.now() / 1000) }) {
  const w = await pow();
  const pre = powPrefix(now, method, path, await sha256(body));
  for (;;) {
    const nonce = concat(random(12), new Uint8Array(4));
    const msg = pad(concat(pre, nonce));
    const off = pre.length + 12;
    for (let start = 0; start < 2 ** 31; start += CHUNK) {
      // Concurrent solves share one instance and interleave at the await
      // below, so the message is rewritten before every (synchronous) search.
      new Uint8Array(w.memory.buffer).set(msg, MSG);
      const ctr = w.search(msg.length / 64, off, bits, start, CHUNK);
      if (ctr >= 0) {
        new DataView(nonce.buffer).setUint32(12, ctr);
        return `${now}.${b32(nonce)}`;
      }
      await new Promise((r) => setTimeout(r, 0));
    }
  }
}
