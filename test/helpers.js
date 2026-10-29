// Test fixtures: an in-memory R2 bucket and a Store wired to the real worker handler.

import { handle } from '../worker/src/handler.js';
import { verifyTag } from '../core/tag.js';
import { Store } from '../core/store.js';
import { createHash } from 'node:crypto';

const etag = (v) => createHash('sha256').update(v).digest('hex').slice(0, 32);

/** Implements the subset of the R2 binding API the worker uses. */
export class MemoryBucket {
  constructor() { this.objects = new Map(); }

  async put(key, value, opts = {}) {
    const cond = opts.onlyIf instanceof Headers ? opts.onlyIf : null;
    if (cond?.get('If-None-Match') === '*' && this.objects.has(key)) return null;
    const ifMatch = cond?.get('If-Match');
    if (ifMatch && (!this.objects.has(key) || etag(this.objects.get(key)) !== ifMatch)) return null;
    this.objects.set(key, new Uint8Array(value));
    return { key };
  }

  async get(key) {
    const v = this.objects.get(key);
    return v ? { key, etag: etag(v), arrayBuffer: async () => v.slice().buffer } : null;
  }

  async head(key) { return this.objects.has(key) ? { key } : null; }

  async delete(keys) { for (const k of [].concat(keys)) this.objects.delete(k); }

  async list({ prefix = '', delimiter, cursor, limit = 1000 } = {}) {
    const keys = [...this.objects.keys()].filter((k) => k.startsWith(prefix)).sort();
    const start = cursor ? Number(cursor) : 0;
    if (delimiter) {
      const prefixes = [...new Set(keys.map((k) => k.slice(prefix.length)).filter((r) => r.includes(delimiter))
        .map((r) => prefix + r.slice(0, r.indexOf(delimiter) + 1)))];
      return { objects: [], delimitedPrefixes: prefixes, truncated: false };
    }
    const page = keys.slice(start, start + limit);
    const truncated = start + limit < keys.length;
    return { objects: page.map((key) => ({ key })), delimitedPrefixes: [], truncated, cursor: truncated ? String(start + limit) : undefined };
  }
}

export function testEnv(overrides = {}) {
  return { BUCKET: new MemoryBucket(), POW_BITS: '8', APP_ORIGINS: 'https://rspm.me', ...overrides };
}

export const deps = { verifyTag };

/** A Store whose requests go to the real worker handler. */
export function testStore(env = testEnv()) {
  const fetch = (input, init) => handle(new Request(input, init), env, deps);
  const store = new Store({ api: 'https://api.test', blocks: 'https://api.test/v1', fetch });
  return { store, env, fetch };
}
