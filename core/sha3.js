// SHA3-256, SHA3-512, SHAKE128 and SHAKE256 (FIPS 202). Zero dependencies.
//
// The 1600-bit Keccak state is 25 lanes of 64 bits, stored as 50 Uint32 words:
// lane i is (lo = s[2i], hi = s[2i + 1]). Absorbing and squeezing go through a
// byte view of the same buffer, which assumes a little-endian host (every JS
// engine in practice; checked below).

if (new Uint8Array(new Uint32Array([1]).buffer)[0] !== 1) throw new Error('sha3.js requires a little-endian host');

// Round constants (FIPS 202 §3.2.5), as [hi, lo] pairs.
const RC = [
  [0x00000000, 0x00000001], [0x00000000, 0x00008082], [0x80000000, 0x0000808a], [0x80000000, 0x80008000],
  [0x00000000, 0x0000808b], [0x00000000, 0x80000001], [0x80000000, 0x80008081], [0x80000000, 0x00008009],
  [0x00000000, 0x0000008a], [0x00000000, 0x00000088], [0x00000000, 0x80008009], [0x00000000, 0x8000000a],
  [0x00000000, 0x8000808b], [0x80000000, 0x0000008b], [0x80000000, 0x00008089], [0x80000000, 0x00008003],
  [0x80000000, 0x00008002], [0x80000000, 0x00000080], [0x00000000, 0x0000800a], [0x80000000, 0x8000000a],
  [0x80000000, 0x80008081], [0x80000000, 0x00008080], [0x00000000, 0x80000001], [0x80000000, 0x80008008],
];
const RC_HI = Uint32Array.from(RC, (c) => c[0]);
const RC_LO = Uint32Array.from(RC, (c) => c[1]);

// ρ and π combined: walking the π permutation from lane (1, 0), step t moves
// the carried lane to PI[t] (a word index) after rotating it by ROT[t].
const PI = new Uint8Array(24), ROT = new Uint8Array(24);
for (let t = 0, x = 1, y = 0; t < 24; t++) {
  [x, y] = [y, (2 * x + 3 * y) % 5];
  PI[t] = 2 * (x + 5 * y);
  ROT[t] = (((t + 1) * (t + 2)) / 2) % 64;
}

const C = new Uint32Array(10);

function keccakF(s) {
  for (let r = 0; r < 24; r++) {
    // θ
    for (let x = 0; x < 10; x++) C[x] = s[x] ^ s[x + 10] ^ s[x + 20] ^ s[x + 30] ^ s[x + 40];
    for (let x = 0; x < 5; x++) {
      const x1 = ((x + 1) % 5) * 2, x4 = ((x + 4) % 5) * 2;
      const dl = C[x4] ^ ((C[x1] << 1) | (C[x1 + 1] >>> 31));
      const dh = C[x4 + 1] ^ ((C[x1 + 1] << 1) | (C[x1] >>> 31));
      for (let y = 0; y < 50; y += 10) { s[2 * x + y] ^= dl; s[2 * x + y + 1] ^= dh; }
    }
    // ρ + π (no ROT entry is 0 or 32, so every shift below is in 1..31)
    let lo = s[2], hi = s[3];
    for (let t = 0; t < 24; t++) {
      const n = ROT[t];
      let nl, nh;
      if (n < 32) { nl = (lo << n) | (hi >>> (32 - n)); nh = (hi << n) | (lo >>> (32 - n)); }
      else { const m = n - 32; nl = (hi << m) | (lo >>> (32 - m)); nh = (lo << m) | (hi >>> (32 - m)); }
      const p = PI[t];
      lo = s[p]; hi = s[p + 1];
      s[p] = nl; s[p + 1] = nh;
    }
    // χ
    for (let y = 0; y < 50; y += 10) {
      for (let x = 0; x < 10; x++) C[x] = s[y + x];
      for (let x = 0; x < 10; x++) s[y + x] = C[x] ^ (~C[(x + 2) % 10] & C[(x + 4) % 10]);
    }
    // ι
    s[0] ^= RC_LO[r]; s[1] ^= RC_HI[r];
  }
}

/** Incremental sponge. `update()` any number of times, then `read()` any number of times. */
export class Keccak {
  constructor(rate, suffix) {
    this.state = new Uint32Array(50);
    this.bytes = new Uint8Array(this.state.buffer);
    this.rate = rate;
    this.suffix = suffix;
    this.pos = 0;
    this.squeezing = false;
  }

  update(data) {
    if (this.squeezing) throw new Error('Keccak: update after read');
    const { bytes, rate } = this;
    for (let i = 0; i < data.length; i++) {
      bytes[this.pos++] ^= data[i];
      if (this.pos === rate) { keccakF(this.state); this.pos = 0; }
    }
    return this;
  }

  read(n) {
    const { bytes, rate } = this;
    if (!this.squeezing) {
      bytes[this.pos] ^= this.suffix;
      bytes[rate - 1] ^= 0x80;
      keccakF(this.state);
      this.pos = 0;
      this.squeezing = true;
    }
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      if (this.pos === rate) { keccakF(this.state); this.pos = 0; }
      out[i] = bytes[this.pos++];
    }
    return out;
  }

  static sha3_256() { return new Keccak(136, 0x06); }
  static sha3_512() { return new Keccak(72, 0x06); }
  static shake128() { return new Keccak(168, 0x1f); }
  static shake256() { return new Keccak(136, 0x1f); }
}

export const sha3_256 = (data) => Keccak.sha3_256().update(data).read(32);
export const sha3_512 = (data) => Keccak.sha3_512().update(data).read(64);
export const shake128 = (data, outLen) => Keccak.shake128().update(data).read(outLen);
export const shake256 = (data, outLen) => Keccak.shake256().update(data).read(outLen);
