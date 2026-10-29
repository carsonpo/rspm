// Client tag (PROTOCOL §9.3). Not a security mechanism — see wasm/tag.wat.

import { wasmInstance } from './wasm.js';

let fn;

export async function tag(now = Date.now() / 1000) {
  fn ??= (await wasmInstance('tag')).exports.tag;
  return (fn(Math.floor(now / 30)) >>> 0).toString(16).padStart(8, '0');
}

export async function verifyTag(header, now = Date.now() / 1000) {
  return header === (await tag(now)) || header === (await tag(now - 30));
}
