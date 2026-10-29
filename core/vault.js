// Vault documents and generations (PROTOCOL §5–7).

import { b32, b32decode, concat, fromUtf8, u32be, u64be, utf8 } from './encoding.js';
import { deflate, inflate, random } from './crypto.js';
import { TYPE, chunk, locate, openBlock, sealBlock } from './block.js';
import { pool } from './store.js';

const CONCURRENCY = 6;
const MIN_BLOCKS = 8;
const TOMBSTONE_TTL = 90 * 86400;

export class VaultNotFoundError extends Error {
  constructor() { super('No vault exists for these credentials'); }
}
export class VaultExistsError extends Error {
  constructor() { super('A vault already exists for these credentials'); }
}
export class CorruptVaultError extends Error {}
export class RollbackError extends Error {
  constructor(found, expected) {
    super(`The server returned an older version of your vault (${found}) than this device has seen (${expected})`);
    this.found = found;
    this.expected = expected;
  }
}

export const emptyDoc = () => ({ v: 1, items: [], tombstones: {}, shares: [], identity: null });
const now = () => Math.floor(Date.now() / 1000);

const headLabel = (g) => concat(utf8('head'), u64be(g));
const dataLabel = (g, w, i) => concat(utf8('data'), u64be(g), w, u32be(i));

async function headRef(keys, g) {
  const l = await locate(keys.loc, headLabel(g));
  return { ...l, path: `b/${l.id}` };
}

async function dataRef(keys, g, w, i) {
  const l = await locate(keys.loc, dataLabel(g, w, i));
  return { ...l, path: `b/${l.id}` };
}

// ── Generation discovery (§6.5) ─────────────────────────────────────────────

/** R(G): the heads a writer keeps so the latest generation stays discoverable. */
export function retained(G) {
  const keep = new Set();
  for (let bit = 1; bit <= G; bit *= 2) {
    keep.add(Math.floor(G / bit) * bit); // G with the low bits below `bit` cleared
    keep.add(bit);
  }
  if (G > 0) keep.add(G);
  return keep;
}

/** Latest generation number, or 0 if no vault exists. */
export function findLatest(store, keys) {
  return searchLatest(async (g) => store.exists((await headRef(keys, g)).path));
}

/** The §6.5 search over an existence oracle `exists(g)`. */
export async function searchLatest(exists) {
  if (!(await exists(1))) return 0;
  // Probe powers of two in parallel batches; the first miss bounds G.
  let k = 0;
  for (let base = 1; ; base += 8) {
    const hits = await Promise.all(Array.from({ length: 8 }, (_, i) => exists(2 ** (base + i))));
    const miss = hits.indexOf(false);
    if (miss >= 0) { k = base + miss - 1; break; }
    if (base > 48) throw new CorruptVaultError('generation search did not terminate');
  }
  let g = 2 ** k;
  for (let j = k - 1; j >= 0; j--) if (await exists(g + 2 ** j)) g += 2 ** j;
  return g;
}

// ── Reading and writing generations ─────────────────────────────────────────

class GoneError extends Error {}

async function loadGeneration(store, keys, g) {
  const h = await headRef(keys, g);
  const block = await store.get(h.path);
  if (!block) throw new GoneError();
  const opened = await openBlock(keys.enc, h.raw, block);
  if (!opened || opened.type !== TYPE.HEAD) throw new CorruptVaultError(`head ${g} failed authentication`);
  const head = JSON.parse(fromUtf8(opened.payload));
  if (head.v !== 1 || head.gen !== g) throw new CorruptVaultError(`head ${g} has the wrong generation`);
  const w = b32decode(head.w);
  const chunks = await pool(Array.from({ length: head.n }, (_, i) => i), CONCURRENCY, async (i) => {
    const d = await dataRef(keys, g, w, i);
    const b = await store.get(d.path);
    if (!b) throw new GoneError();
    const o = await openBlock(keys.enc, d.raw, b);
    if (!o || o.type !== TYPE.DATA) throw new CorruptVaultError(`block ${g}/${i} failed authentication`);
    return o.payload;
  });
  const raw = concat(...chunks);
  if (raw.length !== head.len) throw new CorruptVaultError(`generation ${g} has the wrong length`);
  const doc = JSON.parse(fromUtf8(await inflate(raw)));
  return { gen: g, w, n: head.n, doc };
}

/** Writes generation g. Returns its state, or null if another writer committed g first. */
async function writeGeneration(store, keys, g, doc, onProgress) {
  const raw = await deflate(utf8(JSON.stringify(doc)));
  const chunks = chunk(raw, MIN_BLOCKS);
  const w = random(16);
  const total = chunks.length + 1;
  let done = 0;
  const written = [];
  const tick = () => onProgress?.(++done, total);
  try {
    await pool(chunks, CONCURRENCY, async (c, i) => {
      const d = await dataRef(keys, g, w, i);
      const ok = await store.put(d.path, await sealBlock(keys.enc, d.raw, TYPE.DATA, c));
      if (!ok) throw new Error('data locator collision');
      written.push(d);
      tick();
    });
    const h = await headRef(keys, g);
    const payload = utf8(JSON.stringify({ v: 1, gen: g, w: b32(w), n: chunks.length, len: raw.length, ts: now() }));
    if (await store.put(h.path, await sealBlock(keys.enc, h.raw, TYPE.HEAD, payload))) {
      tick();
      return { gen: g, w, n: chunks.length, doc };
    }
  } catch (err) {
    await cleanup(store, written);
    throw err;
  }
  await cleanup(store, written);
  return null;
}

async function cleanup(store, refs) {
  await pool(refs, CONCURRENCY, (r) => store.del(r.path, r.token).catch(() => false));
}

/** Best-effort removal of a superseded generation (§6.3 step 4). */
async function prune(store, keys, old, newGen) {
  const data = await Promise.all(Array.from({ length: old.n }, (_, i) => dataRef(keys, old.gen, old.w, i)));
  const keep = retained(newGen);
  const heads = await Promise.all([...retained(old.gen)].filter((g) => !keep.has(g)).map((g) => headRef(keys, g)));
  await cleanup(store, [...data, ...heads]);
}

// ── Merge (§6.6) ────────────────────────────────────────────────────────────

export function merge(remote, local) {
  const tombstones = { ...remote.tombstones };
  for (const [id, t] of Object.entries(local.tombstones ?? {})) tombstones[id] = Math.max(tombstones[id] ?? 0, t);
  for (const [id, t] of Object.entries(tombstones)) if (t < now() - TOMBSTONE_TTL) delete tombstones[id];

  const newest = (lists, key) => {
    const m = new Map();
    for (const it of lists.flat()) {
      const cur = m.get(key(it));
      if (!cur || (it.updated ?? 0) > (cur.updated ?? 0)) m.set(key(it), it);
    }
    return [...m.values()];
  };
  const alive = (id, updated) => !(tombstones[id] >= updated);

  return {
    ...remote,
    ...local,
    v: 1,
    items: newest([remote.items, local.items], (i) => i.id).filter((i) => alive(i.id, i.updated)),
    shares: newest([remote.shares ?? [], local.shares ?? []], (s) => s.s).filter((s) => alive(`share:${s.s}`, s.created)),
    tombstones,
    identity: local.identity ?? remote.identity ?? null,
  };
}

// ── Item helpers ────────────────────────────────────────────────────────────

export function newId() {
  return b32(random(16));
}

export function putItem(doc, item) {
  const next = { ...item, id: item.id ?? newId(), updated: Math.max(now(), (item.updated ?? 0) + 1) };
  doc.items = doc.items.filter((i) => i.id !== next.id).concat(next);
  return next;
}

export function removeItem(doc, id) {
  doc.items = doc.items.filter((i) => i.id !== id);
  doc.tombstones[id] = now() + 1;
}

// ── Vault ───────────────────────────────────────────────────────────────────

export class Vault {
  #state;

  constructor(store, keys, state) {
    this.store = store;
    this.keys = keys;
    this.#state = state;
  }

  get gen() { return this.#state.gen; }
  get doc() { return this.#state.doc; }

  static async create(store, keys, doc = emptyDoc(), onProgress) {
    if (await store.exists((await headRef(keys, 1)).path)) throw new VaultExistsError();
    const state = await writeGeneration(store, keys, 1, doc, onProgress);
    if (!state) throw new VaultExistsError();
    return new Vault(store, keys, state);
  }

  /** Opens the latest generation. Throws RollbackError if it is older than `minGen`. */
  static async open(store, keys, { minGen = 0 } = {}) {
    for (let attempt = 0; ; attempt++) {
      const g = await findLatest(store, keys);
      if (g === 0) throw new VaultNotFoundError();
      if (g < minGen) throw new RollbackError(g, minGen);
      try {
        return new Vault(store, keys, await loadGeneration(store, keys, g));
      } catch (err) {
        // A concurrent save pruned the generation between search and read.
        if (!(err instanceof GoneError) || attempt >= 3) throw err;
      }
    }
  }

  /** Re-reads the latest generation from the server. */
  async refresh() {
    const fresh = await Vault.open(this.store, this.keys, { minGen: this.gen });
    this.#state = fresh.#state;
    return this;
  }

  /**
   * Applies `change(doc)` to a copy of the document and saves it as the next
   * generation. If another device saved first, merges and retries.
   */
  async update(change, onProgress) {
    const local = structuredClone(this.doc);
    await change(local);
    let base = this.#state;
    let doc = local;
    for (let attempt = 0; attempt < 5; attempt++) {
      const next = await writeGeneration(this.store, this.keys, base.gen + 1, doc, onProgress);
      if (next) {
        await prune(this.store, this.keys, base, next.gen).catch(() => {});
        this.#state = next;
        return this;
      }
      const latest = await Vault.open(this.store, this.keys, { minGen: base.gen + 1 });
      base = latest.#state;
      doc = merge(base.doc, local);
    }
    throw new Error('Too many concurrent saves — please try again');
  }

  /** Deletes every block of this vault (best-effort). Used after a credential change (§7). */
  async destroy() {
    const s = this.#state;
    await prune(this.store, this.keys, s, 0);
    const heads = await Promise.all([...retained(s.gen)].map((g) => headRef(this.keys, g)));
    await cleanup(this.store, heads);
  }

  /** Moves the vault to new credentials (§7). Returns the new vault. */
  async rekey(newKeys, onProgress) {
    const fresh = await Vault.create(this.store, newKeys, this.doc, onProgress);
    const check = await Vault.open(this.store, newKeys);
    if (JSON.stringify(check.doc) !== JSON.stringify(this.doc)) throw new CorruptVaultError('new vault did not read back');
    await this.destroy();
    return fresh;
  }
}
