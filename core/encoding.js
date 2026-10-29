// Byte encodings used throughout the protocol (PROTOCOL §2.3).

const B32 = 'abcdefghijklmnopqrstuvwxyz234567';

export const utf8 = (s) => new TextEncoder().encode(s);
export const fromUtf8 = (b) => new TextDecoder('utf-8', { fatal: true }).decode(b);

export function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/** RFC 4648 base32, lowercase, no padding. */
export function b32(bytes) {
  let out = '', bits = 0, acc = 0;
  for (const b of bytes) {
    acc = (acc << 8) | b; bits += 8;
    while (bits >= 5) { out += B32[(acc >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits) out += B32[(acc << (5 - bits)) & 31];
  return out;
}

export function b32decode(str) {
  const s = str.toLowerCase();
  const out = [];
  let bits = 0, acc = 0;
  for (const c of s) {
    const v = B32.indexOf(c);
    if (v < 0) throw new Error(`invalid base32 character ${JSON.stringify(c)}`);
    acc = ((acc << 5) | v) & 0xfff; bits += 5;
    if (bits >= 8) { out.push((acc >>> (bits - 8)) & 0xff); bits -= 8; }
  }
  if (bits >= 5 || (acc & ((1 << bits) - 1))) throw new Error('invalid base32 length or padding bits');
  return new Uint8Array(out);
}

export function hex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function unhex(str) {
  if (str.length % 2 || /[^0-9a-f]/i.test(str)) throw new Error('invalid hex');
  const out = new Uint8Array(str.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(str.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function b64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function b64decode(str) {
  const s = atob(str);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export function u16be(n) { return new Uint8Array([(n >>> 8) & 0xff, n & 0xff]); }
export function u32be(n) { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n); return b; }
export function u64be(n) { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, BigInt(n)); return b; }

export function equal(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}
