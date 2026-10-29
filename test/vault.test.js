import { Vault, VaultExistsError, VaultNotFoundError, RollbackError, CorruptVaultError,
  retained, searchLatest, merge, putItem, removeItem, emptyDoc } from '../core/vault.js';
import { subkeys } from '../core/kdf.js';
import { random } from '../core/crypto.js';
import { testStore } from './helpers.js';
import { eq, ok } from '../tools/check.js';

const keys = () => subkeys(random(32), random(16));

async function rejects(p, Type) {
  try { await p; } catch (e) { ok(e instanceof Type, `expected ${Type.name}, got ${e.constructor.name}: ${e.message}`); return e; }
  throw new Error(`expected ${Type.name}`);
}

export async function searchIsCorrectForEveryGeneration() {
  for (let G = 0; G <= 1100; G++) {
    const live = retained(G);
    // Stale heads from interrupted cleanups are always ≤ G.
    for (let s = 1; s <= G; s += 7) live.add(s);
    let probes = 0;
    const got = await searchLatest(async (g) => { probes++; return live.has(g); });
    eq(got, G, `G=${G}`);
    ok(probes <= 2 * Math.log2(G + 2) + 10, `G=${G} used ${probes} probes`);
  }
}

export function retainedIsSmall() {
  for (const G of [1, 2, 3, 1000, 2 ** 20 - 1, 2 ** 40 + 12345]) ok(retained(G).size <= 2 * Math.log2(G + 1) + 2);
  ok(retained(1000).has(1000) && retained(1000).has(512) && retained(1000).has(992));
}

export async function createOpenRoundTrip() {
  const { store, env } = testStore();
  const k = await keys();
  const v = await Vault.create(store, k);
  eq(env.BUCKET.objects.size, 9, 'empty vault is 8 data blocks + 1 head');
  await v.update((d) => { putItem(d, { type: 'login', name: 'GitHub', password: 'x' }); });
  const again = await Vault.open(store, k);
  eq(again.gen, 2);
  eq(again.doc.items.map((i) => i.name), ['GitHub']);
  await rejects(Vault.create(store, k), VaultExistsError);
  await rejects(Vault.open(store, await keys()), VaultNotFoundError);
}

export async function storageStaysBounded() {
  const { store, env } = testStore();
  const k = await keys();
  let v = await Vault.create(store, k);
  for (let i = 0; i < 40; i++) await v.update((d) => { putItem(d, { type: 'note', name: `n${i}`, body: 'hello' }); });
  eq(v.gen, 41);
  eq((await Vault.open(store, k)).doc.items.length, 40);
  // 8 data blocks for the live generation + retained heads only.
  ok(env.BUCKET.objects.size <= 8 + retained(41).size, `bucket holds ${env.BUCKET.objects.size} objects`);
}

export async function largeVaultPadsToPowerOfTwo() {
  const { store, env } = testStore();
  const k = await keys();
  const v = await Vault.create(store, k);
  const { b64 } = await import('../core/encoding.js');
  const blob = b64(random(40000)); // ~40 KB even after compression → 10 chunks → padded to 16
  await v.update((d) => { putItem(d, { type: 'note', name: 'big', body: blob }); });
  const data = env.BUCKET.objects.size - retained(2).size;
  ok(data === 16, `expected 16 data blocks, got ${data}`);
  eq((await Vault.open(store, k)).doc.items[0].body, blob);
}

export async function concurrentSavesMerge() {
  const { store } = testStore();
  const k = await keys();
  await Vault.create(store, k);
  const a = await Vault.open(store, k);
  const b = await Vault.open(store, k);
  await a.update((d) => { putItem(d, { type: 'login', name: 'from A' }); });
  await b.update((d) => { putItem(d, { type: 'login', name: 'from B' }); });
  const final = await Vault.open(store, k);
  eq(final.gen, 3);
  eq(final.doc.items.map((i) => i.name).sort(), ['from A', 'from B']);
}

export async function rollbackIsDetected() {
  const { store, env } = testStore();
  const k = await keys();
  const v = await Vault.create(store, k);
  const snapshot = new Map(env.BUCKET.objects);
  await v.update((d) => { putItem(d, { type: 'note', name: 'newer' }); });
  env.BUCKET.objects = snapshot; // malicious server restores an old state
  const err = await rejects(Vault.open(store, k, { minGen: v.gen }), RollbackError);
  eq([err.found, err.expected], [1, 2]);
}

export async function tamperingIsDetected() {
  const { store, env } = testStore();
  const k = await keys();
  await Vault.create(store, k);
  for (const [key, val] of env.BUCKET.objects) {
    const copy = val.slice();
    copy[100] ^= 1;
    env.BUCKET.objects.set(key, copy);
    await rejects(Vault.open(store, k), CorruptVaultError);
    env.BUCKET.objects.set(key, val);
  }
  // Swapping two valid blocks is also caught (locator is bound into the AAD).
  const [[k1, v1], [k2, v2]] = [...env.BUCKET.objects].filter(([, b]) => b);
  env.BUCKET.objects.set(k1, v2);
  env.BUCKET.objects.set(k2, v1);
  await rejects(Vault.open(store, k), CorruptVaultError);
}

export async function rekeyMovesAndDestroys() {
  const { store, env } = testStore();
  const oldK = await keys(), newK = await keys();
  const v = await Vault.create(store, oldK);
  await v.update((d) => { putItem(d, { type: 'login', name: 'keep me' }); });
  const moved = await v.rekey(newK);
  eq(moved.doc.items[0].name, 'keep me');
  await rejects(Vault.open(store, oldK), VaultNotFoundError);
  eq(env.BUCKET.objects.size, 9, 'only the new vault remains');
}

export function mergeRules() {
  const base = emptyDoc();
  const a = structuredClone(base), b = structuredClone(base);
  const item = putItem(a, { type: 'login', name: 'old' });
  const remote = structuredClone(a);
  b.items = [{ ...item, name: 'newer', updated: item.updated + 10 }];
  eq(merge(remote, b).items[0].name, 'newer', 'newest edit wins');
  removeItem(remote, item.id);
  eq(merge(remote, a).items.length, 0, 'tombstone beats an older edit');
  eq(merge(remote, b).items.length, 1, 'an edit newer than the tombstone survives');
}
