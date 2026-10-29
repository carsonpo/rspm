// Regression tests for the 2026-10 security review. Each one fails on the
// code before the fix (base revision 2d7f03c).

import { readFileSync } from 'node:fs';
import { Vault, RollbackError, putItem } from '../core/vault.js';
import { subkeys } from '../core/kdf.js';
import { random, sha256, x25519, x25519Generate } from '../core/crypto.js';
import { locate } from '../core/block.js';
import { concat, hex, utf8 } from '../core/encoding.js';
import {
  createLinkShare, createRecipientShare, openShare, deleteShare, createIdentity, lookupHandle,
  publishHandle, unpublishHandle, migrateHandle, buildHandleRecord, handlePath, ShareError,
} from '../core/share.js';
import { solve } from '../core/pow.js';
import { tag } from '../core/tag.js';
import { handle } from '../worker/src/handler.js';
import { testStore, deps } from './helpers.js';
import { eq, ok } from '../tools/check.js';

const keys = () => subkeys(random(32), random(16));
const hasX25519 = await (async () => {
  try { const a = await x25519Generate(), b = await x25519Generate(); await x25519(a.sk, b.pk); return true; } catch { return false; }
})();
const item = { type: 'login', name: 'Bank', password: 'test-only' };

async function rejects(p, cls, pattern) {
  try { await p; } catch (e) {
    ok(e instanceof cls, `expected ${cls.name}, got ${e?.constructor?.name}: ${e?.message}`);
    if (pattern) ok(pattern.test(e.message), e.message);
    return e;
  }
  throw new Error(`expected ${cls.name}`);
}

// ── 1. Rollback: an older revision opens read-only ──────────────────────────

export async function rolledBackVaultIsReadOnly() {
  const { store, env } = testStore();
  const k = await keys();
  const vault = await Vault.create(store, k);
  const snapshot = new Map(env.BUCKET.objects);
  await vault.update((d) => putItem(d, { ...item, name: 'newer' }));
  const newer = env.BUCKET.objects;
  env.BUCKET.objects = new Map(snapshot); // the server hides generation 2

  // Exactly how the app opens it after "Open older revision" (this device has seen generation 2).
  await rejects(Vault.open(store, k, { minGen: 2 }), RollbackError);
  const old = await Vault.open(store, k, { minGen: 2, readOnlyIfOlder: true });
  eq(old.gen, 1);
  ok(old.readOnly instanceof RollbackError);
  await rejects(old.update((d) => putItem(d, { ...item, name: 'stale write' })), RollbackError);
  await rejects(old.rekey(await keys()), RollbackError);
  await rejects(old.destroy(), RollbackError);
  eq([...env.BUCKET.objects.keys()].sort(), [...snapshot.keys()].sort(), 'nothing was written');

  // Once the newer generation is back, a refresh makes it writable again.
  env.BUCKET.objects = newer;
  await old.refresh();
  eq(old.readOnly, null);
  eq(old.doc.items.map((i) => i.name), ['newer']);
  await old.update((d) => putItem(d, { ...item, name: 'after' }));
  eq(old.gen, 3);
}

export function sessionOpensOlderRevisionsReadOnly() {
  const src = readFileSync(new URL('../app/src/session.js', import.meta.url), 'utf8');
  ok(/readOnlyIfOlder: allowRollback/.test(src), 'signIn must open rolled-back vaults read-only');
  ok(!/minGen: allowRollback \? 0/.test(src), 'signIn must not drop the minimum generation');
  ok(/if \(!s \|\| !writable\(\)\) return false;/.test(src), 'save() must refuse when read-only');
}

// ── 2. Share deletion failures are reported ─────────────────────────────────

export async function shareDeletionFailureIsReported() {
  const { store } = testStore();
  const link = await createLinkShare(store, item);
  const del = store.del.bind(store);
  store.del = async () => { throw new Error('simulated 503'); };
  await rejects(deleteShare(store, link.entry), ShareError, /couldn’t be deleted/);
  eq((await openShare(store, new URL(link.url).hash)).item, item, 'still there, and the caller knows it');
  store.del = del;
  await deleteShare(store, link.entry);
  await deleteShare(store, link.entry); // already gone counts as deleted
  await rejects(openShare(store, new URL(link.url).hash), ShareError, /expired or was revoked/);
}

export async function recipientShareDeletionFailureIsReported() {
  if (!hasX25519) { console.log('        (skipped: this runtime has no X25519 in WebCrypto)'); return; }
  const { store } = testStore();
  const bob = await createIdentity('bob');
  await publishHandle(store, bob);
  const rec = await createRecipientShare(store, item, await lookupHandle(store, 'bob'));
  const del = store.del.bind(store);
  store.del = async () => { throw new Error('simulated 503'); };
  await rejects(deleteShare(store, rec.entry), ShareError, /couldn’t be deleted/);
  // Partial failure: everything else is still attempted, and a retry finishes the job.
  let calls = 0;
  store.del = async (...a) => (calls++ === 0 ? Promise.reject(new Error('flaky')) : del(...a));
  await rejects(deleteShare(store, rec.entry), ShareError, /1 of/);
  store.del = del;
  await deleteShare(store, rec.entry);
  await rejects(openShare(store, new URL(rec.url).hash, bob), ShareError, /expired or was revoked/);
}

// ── 3. Burn is cooperative, and the app says so ─────────────────────────────

export async function burnIsCooperativeNotSingleView() {
  const { store } = testStore();
  const { url } = await createLinkShare(store, item, { burn: true });
  const frag = new URL(url).hash;
  const [a, b] = await Promise.all([openShare(store, frag), openShare(store, frag)]);
  eq(a.item, item);
  eq(b.item, item); // inherent: both read before either deletes
  const ui = readFileSync(new URL('../app/src/views/share.js', import.meta.url), 'utf8');
  ok(!/One view only/.test(ui), 'the app must not promise single viewing');
}

// ── 4. Handle authorization survives credential changes ─────────────────────

/** A version 1 record: delete token derived from the vault's location key. */
async function legacyRecord(identity, locKey) {
  const rec = await buildHandleRecord(identity);
  const { token } = await locate(locKey, concat(utf8('handle'), utf8(identity.handle)));
  rec.set(await sha256(token), 1223);
  return { rec, token };
}

export async function handleTokenMovesWithTheIdentity() {
  const { store } = testStore();
  const oldKeys = await keys();
  const identity = await createIdentity('carson');
  ok(await publishHandle(store, identity));
  const vault = await Vault.create(store, oldKeys, { v: 1, items: [], tombstones: {}, shares: [], identity });
  const fresh = await vault.rekey(await keys());
  ok(await unpublishHandle(store, fresh.doc.identity), 'the new vault can remove its handle');
  eq(await lookupHandle(store, 'carson'), null);
}

export async function legacyHandleIsMigratedAtomically() {
  const { store, env } = testStore();
  const oldLoc = random(32);
  const identity = await createIdentity('carson');
  const path = await handlePath('carson');
  const { rec, token: legacy } = await legacyRecord(identity, oldLoc);
  env.BUCKET.objects.set(path, rec);

  eq(await migrateHandle(store, identity, random(32)), 'stale', 'unrelated keys can’t migrate it');
  eq(await migrateHandle(store, identity, oldLoc), 'migrated');
  eq(await migrateHandle(store, identity, oldLoc), 'current');
  ok(await lookupHandle(store, 'carson'), 'the handle was never free');
  eq(await store.del(path, legacy).catch((e) => e.status), 403, 'the old credentials’ token is dead');
  ok(await unpublishHandle(store, identity));

  const other = await createIdentity('mallory');
  await publishHandle(store, other);
  eq(await migrateHandle(store, { ...identity, handle: 'mallory' }, oldLoc), 'foreign');
}

export async function handleReplaceIsAuthorizedAndConditional() {
  const { env } = testStore();
  const identity = await createIdentity('carson');
  const path = await handlePath('carson');
  const oldLoc = random(32);
  const { rec, token } = await legacyRecord(identity, oldLoc);
  env.BUCKET.objects.set(path, rec);
  const put = async (p, body, replace) => handle(new Request(`https://api.test/v1/${p}`, {
    method: 'PUT', body,
    headers: { 'RSPM-PoW': await solve({ method: 'PUT', path: p, body, bits: 8 }), 'RSPM-Tag': await tag(), 'RSPM-Replace': replace },
  }), env, deps);
  const next = await buildHandleRecord(identity);
  eq((await put(path, next, hex(random(32)))).status, 403, 'wrong token');
  eq((await put(path, next, 'zz')).status, 400, 'malformed token');
  eq((await put(await handlePath('someone'), await buildHandleRecord(await createIdentity('someone')), hex(token))).status, 404, 'nothing to replace');
  const block = random(4096); block[0] = 1;
  eq((await put('b/aaaaaaaaaaaaaaaaaaaaaaaaaa', block, hex(token))).status, 400, 'only handles');
  eq((await put(path, next, hex(token))).status, 200);
  eq((await put(path, next, hex(token))).status, 403, 'the old token no longer replaces it');

  // The write is conditional on the record it checked.
  const obj = await env.BUCKET.get(path);
  env.BUCKET.objects.set(path, await buildHandleRecord(identity));
  eq(await env.BUCKET.put(path, next, { onlyIf: new Headers({ 'If-Match': obj.etag }) }), null);
}

// ── 5. A share is only shown once it's tracked ──────────────────────────────

export function shareIsShownOnlyOnceSaved() {
  const src = readFileSync(new URL('../app/src/views/share.js', import.meta.url), 'utf8');
  const create = src.slice(src.indexOf('const create = async'), src.indexOf('const canCreate'));
  ok(/if \(await save\([\s\S]*?\)\) \{\s*result\.value = url;/.test(create), 'the link is shown only after the vault save succeeds');
  ok(/await deleteShare\(store, entry\)/.test(create), 'an untracked share is deleted');
}

// ── 6. Locking closes dialogs ───────────────────────────────────────────────

export function lockClosesDialogs() {
  const src = readFileSync(new URL('../app/src/session.js', import.meta.url), 'utf8');
  ok(/export function lock\(\) \{\s*closeAllDialogs\(\);/.test(src), 'lock() must close every dialog first');
}
