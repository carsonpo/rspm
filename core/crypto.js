// Thin wrappers over WebCrypto for the primitives in PROTOCOL §2.1.

import { concat, utf8 } from './encoding.js';

const subtle = globalThis.crypto.subtle;
const bytes = (x) => (typeof x === 'string' ? utf8(x) : x);

export function random(n) {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return b;
}

export async function sha256(...parts) {
  return new Uint8Array(await subtle.digest('SHA-256', concat(...parts.map(bytes))));
}

export async function hmac(key, ...parts) {
  const k = await subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await subtle.sign('HMAC', k, concat(...parts.map(bytes))));
}

export async function hkdf(ikm, salt, info, len = 32) {
  const k = await subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  const bits = await subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: bytes(salt), info: bytes(info) }, k, len * 8);
  return new Uint8Array(bits);
}

export async function aesKey(raw) {
  return subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export async function seal(key, nonce, plaintext, aad) {
  return new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: aad }, key, plaintext));
}

/** Returns plaintext, or null if authentication fails. */
export async function open(key, nonce, ciphertext, aad) {
  try {
    return new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: nonce, additionalData: aad }, key, ciphertext));
  } catch {
    return null;
  }
}

export async function x25519Generate() {
  const kp = await subtle.generateKey({ name: 'X25519' }, true, ['deriveBits']);
  return {
    sk: new Uint8Array(await subtle.exportKey('pkcs8', kp.privateKey)),
    pk: new Uint8Array(await subtle.exportKey('raw', kp.publicKey)),
  };
}

export async function x25519(skPkcs8, pkRaw) {
  const sk = await subtle.importKey('pkcs8', skPkcs8, { name: 'X25519' }, false, ['deriveBits']);
  const pk = await subtle.importKey('raw', pkRaw, { name: 'X25519' }, false, []);
  return new Uint8Array(await subtle.deriveBits({ name: 'X25519', public: pk }, sk, 256));
}

// CompressionStream is a web standard; runtimes without it (some Bun versions)
// fall back to their built-in node:zlib, which produces the same deflate-raw format.
export async function deflate(data) {
  if (typeof CompressionStream === 'undefined') return new Uint8Array((await import('node:zlib')).deflateRawSync(data));
  return pipe(data, new CompressionStream('deflate-raw'));
}

export async function inflate(data) {
  if (typeof DecompressionStream === 'undefined') return new Uint8Array((await import('node:zlib')).inflateRawSync(data));
  return pipe(data, new DecompressionStream('deflate-raw'));
}

async function pipe(data, transform) {
  const stream = new Blob([data]).stream().pipeThrough(transform);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
