// Shared build helpers.

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assemble } from './wat.js';

export const root = fileURLToPath(new URL('..', import.meta.url));

/** Assembles wasm/*.wat. Returns { name: bytes }; writes wasm/*.wasm unless `write` is false. */
export function buildWasm({ write = true } = {}) {
  const dir = join(root, 'wasm');
  const built = {};
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.wat')).sort()) {
    const bytes = assemble(readFileSync(join(dir, f), 'utf8'));
    if (!WebAssembly.validate(bytes)) throw new Error(`${f}: failed WebAssembly.validate`);
    if (write) writeFileSync(join(dir, f.replace(/\.wat$/, '.wasm')), bytes);
    built[f.replace(/\.wat$/, '')] = bytes;
  }
  return built;
}
