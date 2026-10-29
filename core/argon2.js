// Argon2id v1.3 (RFC 9106) and BLAKE2b (RFC 7693) via wasm/argon2.wat.
//
// Each call gets a fresh instance (and so fresh memory) from the cached
// compiled module, and wipes that memory before returning.

import { wasmInstance } from './wasm.js';

const H0 = 3200;            // H0 location expected by the module
const IO = 8192;            // caller I/O area
const IO_LEN = 65536 - IO;
const MAX_BLOCKS = 4194240; // 1 + ceil(m'/64) pages must fit in 65536 pages

function u8(x, what) {
  if (!(x instanceof Uint8Array)) throw new TypeError(`${what} must be a Uint8Array`);
  return x;
}

function le32(n) {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n, true);
  return b;
}

// BLAKE2b streaming over the module's I/O area.
function hasher(exports) {
  return {
    init(outLen, key = new Uint8Array(0)) {
      new Uint8Array(exports.memory.buffer).set(key, IO);
      exports.b2_init(outLen, IO, key.length);
    },
    update(data) {
      for (let o = 0; o < data.length; o += IO_LEN) {
        const chunk = data.subarray(o, o + IO_LEN);
        new Uint8Array(exports.memory.buffer).set(chunk, IO);
        exports.b2_update(IO, chunk.length);
      }
    },
  };
}

const wipe = (exports) => new Uint8Array(exports.memory.buffer).fill(0);

/** BLAKE2b with a digest of `outLen` (1..64) bytes and an optional key (≤ 64 bytes). */
export async function blake2b(data, outLen = 64, key = new Uint8Array(0)) {
  u8(data, 'data'); u8(key, 'key');
  if (!Number.isInteger(outLen) || outLen < 1 || outLen > 64) throw new RangeError('outLen must be 1..64');
  if (key.length > 64) throw new RangeError('key must be at most 64 bytes');
  const { exports } = await wasmInstance('argon2');
  try {
    const h = hasher(exports);
    h.init(outLen, key);
    h.update(data);
    exports.b2_final(IO);
    return new Uint8Array(exports.memory.buffer, IO, outLen).slice();
  } finally {
    wipe(exports);
  }
}

/**
 * Argon2id. `m` is memory in KiB, `t` passes, `p` lanes, `len` tag bytes.
 * Optional `secret` (K) and `ad` (X) per RFC 9106 §3.2.
 */
export async function argon2id(password, salt, { m, t, p, len, secret = new Uint8Array(0), ad = new Uint8Array(0) }) {
  u8(password, 'password'); u8(salt, 'salt'); u8(secret, 'secret'); u8(ad, 'ad');
  const int = (v, lo, hi, what) => {
    if (!Number.isInteger(v) || v < lo || v > hi) throw new RangeError(`${what} must be an integer in ${lo}..${hi}`);
  };
  int(p, 1, 0xffffff, 'p');
  int(t, 1, 0xffffffff, 't');
  int(len, 4, IO_LEN, 'len');
  int(m, 8 * p, 0xffffffff, 'm');
  if (salt.length < 8) throw new RangeError('salt must be at least 8 bytes');
  const mp = 4 * p * Math.floor(m / (4 * p));
  if (mp > MAX_BLOCKS) throw new RangeError(`m too large for wasm32 memory (max ${MAX_BLOCKS} KiB)`);

  const { exports } = await wasmInstance('argon2');
  try {
    const h = hasher(exports);
    h.init(64);
    for (const v of [p, len, m, t, 0x13, 2]) h.update(le32(v));
    for (const field of [password, salt, secret, ad]) {
      h.update(le32(field.length));
      h.update(field);
    }
    exports.b2_final(H0);

    const pages = 1 + Math.ceil(mp / 64);
    const have = exports.memory.buffer.byteLength / 65536;
    if (pages > have) exports.memory.grow(pages - have);

    exports.argon2(mp, t, p, len);
    return new Uint8Array(exports.memory.buffer, IO, len).slice();
  } finally {
    wipe(exports);
  }
}
