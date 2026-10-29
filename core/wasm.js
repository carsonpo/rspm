// Loads a WebAssembly module from wasm/{name}.wasm.
//
// The single-file app build inlines every module as base64 in
// globalThis.RSPM_WASM; everywhere else (Node, Bun, Deno, dev server) the
// file is read next to this module.

import { b64decode } from './encoding.js';

const cache = new Map();

export async function wasmBytes(name) {
  const inlined = globalThis.RSPM_WASM?.[name];
  if (inlined) return b64decode(inlined);
  const url = new URL(`../wasm/${name}.wasm`, import.meta.url);
  if (url.protocol === 'file:') {
    const { readFile } = await import('node:fs/promises');
    return new Uint8Array(await readFile(url));
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`failed to load ${name}.wasm: ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

export function wasmModule(name) {
  if (!cache.has(name)) cache.set(name, wasmBytes(name).then((b) => WebAssembly.compile(b)));
  return cache.get(name);
}

export async function wasmInstance(name, imports = {}) {
  return WebAssembly.instantiate(await wasmModule(name), imports);
}
