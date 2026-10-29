// Client for the worker API and public bucket (PROTOCOL §9).

import { solve } from './pow.js';
import { tag } from './tag.js';
import { hex } from './encoding.js';

export const DEFAULT_ENDPOINTS = Object.freeze({
  api: 'https://api.rspm.me',
  blocks: 'https://api.rspm.me/v1',
});

export class StoreError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

export class Store {
  /**
   * @param {{ api: string, blocks: string, fetch?: typeof fetch, onWork?: (n: number) => void }} opts
   *   blocks: base URL objects are read from: `${api}/v1` (the worker), or a public bucket domain.
   */
  constructor({ api, blocks, fetch: f = globalThis.fetch.bind(globalThis) } = DEFAULT_ENDPOINTS) {
    this.api = api.replace(/\/$/, '');
    this.blocks = blocks.replace(/\/$/, '');
    this.fetch = f;
    this.bits = null;
  }

  async get(path) {
    const res = await this.fetch(`${this.blocks}/${path}`, { cache: 'no-store' });
    if (res.status === 404) return null;
    if (!res.ok) throw new StoreError(`read failed (${res.status})`, res.status);
    return new Uint8Array(await res.arrayBuffer());
  }

  /** Existence check. The query string defeats any cached 404s (§6.5 depends on fresh answers). */
  async exists(path) {
    const q = Math.random().toString(36).slice(2);
    const res = await this.fetch(`${this.blocks}/${path}?n=${q}`, { method: 'HEAD', cache: 'no-store' });
    if (res.status === 404) return false;
    if (!res.ok) throw new StoreError(`lookup failed (${res.status})`, res.status);
    return true;
  }

  async difficulty() {
    if (this.bits === null) {
      const res = await this.fetch(`${this.api}/v1/pow`, { cache: 'no-store' });
      if (!res.ok) throw new StoreError(`server unavailable (${res.status})`, res.status);
      this.bits = (await res.json()).d;
    }
    return this.bits;
  }

  async #send(method, path, body, extra = {}) {
    const headers = {
      'Content-Type': 'application/octet-stream',
      'RSPM-PoW': await solve({ method, path, body, bits: await this.difficulty() }),
      'RSPM-Tag': await tag(),
      ...extra,
    };
    return this.fetch(`${this.api}/v1/${path}`, { method, headers, body });
  }

  /** Create-once write. Returns true if created, false if the object already exists. */
  async put(path, body) {
    const res = await this.#send('PUT', path, body);
    if (res.status === 201) return true;
    if (res.status === 409) return false;
    if (res.status === 403 && (await res.clone().text()).includes('pow')) this.bits = null;
    throw new StoreError(`write failed (${res.status}): ${await res.text()}`, res.status);
  }

  /**
   * Replaces a handle record in place, authorized by its current delete token.
   * Returns true if replaced, false if the record changed concurrently.
   */
  async replace(path, body, token) {
    const res = await this.#send('PUT', path, body, { 'RSPM-Replace': hex(token) });
    if (res.status === 200) return true;
    if (res.status === 409) return false;
    if (res.status === 403 && (await res.clone().text()).includes('pow')) this.bits = null;
    throw new StoreError(`replace failed (${res.status}): ${await res.text()}`, res.status);
  }

  /** Delete by token. Returns true if deleted, false if it did not exist. */
  async del(path, token) {
    const res = await this.#send('DELETE', path, token);
    if (res.status === 204) return true;
    if (res.status === 404) return false;
    throw new StoreError(`delete failed (${res.status}): ${await res.text()}`, res.status);
  }
}

/** Runs `fn` over items with bounded concurrency, preserving order. */
export async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}
