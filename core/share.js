// Sharing and public handles (PROTOCOL §8).

import { b32, b32decode, b64, b64decode, concat, equal, fromUtf8, u32be, utf8 } from './encoding.js';
import { aesKey, deflate, hkdf, inflate, random, sha256, x25519, x25519Generate } from './crypto.js';
import { TYPE, chunk, locate, openBlock, sealBlock, BLOCK } from './block.js';
import * as mlkem from './mlkem.js';
import { pool } from './store.js';

export const MAX_HOURS = 720;
export const LINK_ORIGIN = 'https://rspm.link';

export class ShareError extends Error {}

const nowHour = () => Math.floor(Date.now() / 3600000);

// ── Envelope (§8.1) ─────────────────────────────────────────────────────────

async function envelopeKeys(s) {
  return {
    loc: await hkdf(s, 'rspm/v1', 'share/loc'),
    enc: await aesKey(await hkdf(s, 'rspm/v1', 'share/enc')),
  };
}

async function shareRef(keys, hour, i) {
  const l = await locate(keys.loc, concat(utf8('share'), u32be(i)));
  return { ...l, path: `e/${hour}/${l.id}` };
}

async function writeEnvelope(store, s, hour, payload, meta) {
  const keys = await envelopeKeys(s);
  const raw = await deflate(utf8(JSON.stringify(payload)));
  const chunks = chunk(raw, 1);
  const head = utf8(JSON.stringify({ v: 1, n: chunks.length, len: raw.length, exp: hour, ...meta }));
  const blocks = [[TYPE.SHARE_HEAD, head], ...chunks.map((c) => [TYPE.SHARE_DATA, c])];
  await pool(blocks, 6, async ([type, body], i) => {
    const r = await shareRef(keys, hour, i);
    if (!(await store.put(r.path, await sealBlock(keys.enc, r.raw, type, body)))) throw new ShareError('share locator collision');
  });
  return chunks.length;
}

async function readEnvelope(store, s, hour) {
  const keys = await envelopeKeys(s);
  const h = await shareRef(keys, hour, 0);
  const hb = await store.get(h.path);
  if (!hb) throw new ShareError('This share has expired or was revoked');
  const ho = await openBlock(keys.enc, h.raw, hb);
  if (!ho || ho.type !== TYPE.SHARE_HEAD) throw new ShareError('This share link is invalid');
  const meta = JSON.parse(fromUtf8(ho.payload));
  if (meta.exp !== hour) throw new ShareError('This share link is invalid');
  const chunks = await pool(Array.from({ length: meta.n }, (_, i) => i + 1), 6, async (i) => {
    const r = await shareRef(keys, hour, i);
    const o = await openBlock(keys.enc, r.raw, await store.get(r.path));
    if (!o || o.type !== TYPE.SHARE_DATA) throw new ShareError('This share is damaged');
    return o.payload;
  });
  const raw = concat(...chunks);
  if (raw.length !== meta.len) throw new ShareError('This share is damaged');
  return { meta, payload: JSON.parse(fromUtf8(await inflate(raw))) };
}

async function envelopeRefs(s, hour, n) {
  const keys = await envelopeKeys(s);
  return Promise.all(Array.from({ length: n + 1 }, (_, i) => shareRef(keys, hour, i)));
}

/**
 * Deletes every ref, attempting all of them even if some fail, then throws if
 * any failed. Already-missing objects count as deleted, so retrying is safe.
 */
async function deleteAll(store, refs) {
  const errors = [];
  await pool(refs, 6, (r) => store.del(r.path, r.token).catch((err) => { errors.push(err); }));
  if (errors.length) {
    throw new ShareError(`${errors.length} of ${refs.length} parts of the share couldn’t be deleted from the server (${errors[0].message}). Try again.`);
  }
}

function checkHours(hours) {
  if (!Number.isInteger(hours) || hours < 1 || hours > MAX_HOURS) throw new ShareError(`Expiry must be 1–${MAX_HOURS} hours`);
  return nowHour() + hours;
}

// ── Link shares (§8.2) ──────────────────────────────────────────────────────

/** Returns { url, entry } — store `entry` in the vault's `shares` so it can be revoked. */
export async function createLinkShare(store, item, { hours = 24, burn = false, from = null, origin = LINK_ORIGIN } = {}) {
  const hour = checkHours(hours);
  const s = random(32);
  const n = await writeEnvelope(store, s, hour, item, { burn, from });
  const entry = { kind: 'link', s: b32(s), hour, n, created: Math.floor(Date.now() / 1000), name: item.name ?? '' };
  return { url: `${origin}/#l1.${hour}.${b32(s)}`, entry };
}

// ── Handles (§8.3.1) ────────────────────────────────────────────────────────

export function normalizeHandle(h) {
  const n = h.trim().normalize('NFKC').toLowerCase();
  if (!/^[a-z0-9_-]{3,32}$/.test(n)) throw new ShareError('Handles are 3–32 characters: a–z, 0–9, _ and -');
  return n;
}

export async function handlePath(handle) {
  return `h/${b32((await sha256('rspm/v1/handle', normalizeHandle(handle))).slice(0, 16))}`;
}

export async function fingerprint(xpk, ek) {
  const fp = (await sha256('rspm/v1/fp', xpk, ek)).slice(0, 20);
  return b32(fp).toUpperCase().match(/.{4}/g).join(' ');
}

/** A new identity for the vault's `identity` field. */
export async function createIdentity(handle) {
  const x = await x25519Generate();
  return { handle: normalizeHandle(handle), x25519_sk: b64(x.sk), x25519_pk: b64(x.pk), mlkem_seed: b64(random(mlkem.SEED_BYTES)) };
}

function identityKeys(identity) {
  const { ek, dk } = mlkem.keygen(b64decode(identity.mlkem_seed));
  return { xsk: b64decode(identity.x25519_sk), xpk: b64decode(identity.x25519_pk), ek, dk };
}

/**
 * The handle's delete/replace token, derived from the identity's own secrets
 * so it moves with the identity through credential changes (§8.3.1).
 */
const handleToken = (identity) => hkdf(concat(b64decode(identity.x25519_sk), b64decode(identity.mlkem_seed)), 'rspm/v1', 'handle-token');
/** Version 1 records derived the token from the vault's location key instead. */
const legacyHandleToken = async (locKey, handle) => (await locate(locKey, concat(utf8('handle'), utf8(handle)))).token;

export async function buildHandleRecord(identity) {
  const { xpk, ek } = identityKeys(identity);
  const name = utf8(identity.handle);
  const token = await handleToken(identity);
  const rec = random(BLOCK);
  rec[0] = 0x01;
  rec.set(utf8('RSPMH1'), 1);
  rec.set(xpk, 7);
  rec.set(ek, 39);
  rec.set(await sha256(token), 1223);
  rec[1255] = name.length;
  rec.set(name, 1256);
  return rec;
}

export function parseHandleRecord(rec) {
  if (!rec || rec.length !== BLOCK || rec[0] !== 0x01 || fromUtf8(rec.subarray(1, 7)) !== 'RSPMH1') return null;
  const len = rec[1255];
  if (len < 3 || len > 32) return null;
  return {
    xpk: rec.slice(7, 39),
    ek: rec.slice(39, 1223),
    verifier: rec.slice(1223, 1255),
    handle: fromUtf8(rec.subarray(1256, 1256 + len)),
  };
}

/** Publishes the identity's handle. Returns false if the handle is taken by someone else. */
export async function publishHandle(store, identity) {
  const path = await handlePath(identity.handle);
  if (await store.put(path, await buildHandleRecord(identity))) return true;
  // Already ours (e.g. published from another device)?
  const existing = parseHandleRecord(await store.get(path));
  return !!existing && equal(existing.xpk, b64decode(identity.x25519_pk));
}

/**
 * Moves a version 1 handle record (token derived from `locKey`) to the
 * identity-derived token, replacing it atomically so the handle is never free.
 * Returns 'current', 'migrated', 'missing', 'foreign' (not ours), or 'stale'
 * (a version 1 record from credentials older than `locKey`, which can't be updated).
 */
export async function migrateHandle(store, identity, locKey) {
  const path = await handlePath(identity.handle);
  const rec = parseHandleRecord(await store.get(path));
  if (!rec) return 'missing';
  if (!equal(rec.xpk, b64decode(identity.x25519_pk))) return 'foreign';
  if (equal(rec.verifier, await sha256(await handleToken(identity)))) return 'current';
  const legacy = await legacyHandleToken(locKey, identity.handle);
  if (!equal(rec.verifier, await sha256(legacy))) return 'stale';
  if (!(await store.replace(path, await buildHandleRecord(identity), legacy))) throw new ShareError('The handle changed while updating it. Try again.');
  return 'migrated';
}

export async function unpublishHandle(store, identity) {
  return store.del(await handlePath(identity.handle), await handleToken(identity));
}

export async function lookupHandle(store, handle) {
  const rec = parseHandleRecord(await store.get(await handlePath(handle)));
  if (!rec || rec.handle !== normalizeHandle(handle)) return null;
  if (!mlkem.checkEncapsulationKey(rec.ek)) return null;
  return { handle: rec.handle, xpk: rec.xpk, ek: rec.ek, fingerprint: await fingerprint(rec.xpk, rec.ek) };
}

// ── Recipient shares (§8.3.2) ───────────────────────────────────────────────

export async function hybridSecret(ssx, ssk, ephPk, ct, xpk, ek) {
  // The ciphertext is bound by hash: WebCrypto implementations cap HKDF info at 1024 bytes.
  return hkdf(concat(ssx, ssk), 'rspm/v1/hybrid', concat(ephPk, await sha256(ct), xpk, await sha256(ek)));
}

const keyBlockRef = async (s, hour) => {
  const l = await locate(s, utf8('keyblock'));
  return { ...l, path: `e/${hour}/${l.id}` };
};

export async function createRecipientShare(store, item, recipient, { hours = 24, burn = false, from = null, origin = LINK_ORIGIN } = {}) {
  const hour = checkHours(hours);
  const eph = await x25519Generate();
  const ssx = await x25519(eph.sk, recipient.xpk);
  const { ct, ss } = mlkem.encaps(recipient.ek);
  const s = await hybridSecret(ssx, ss, eph.pk, ct, recipient.xpk, recipient.ek);
  const kb = await keyBlockRef(s, hour);
  const block = random(BLOCK);
  block[0] = 0x01;
  block.set(eph.pk, 1);
  block.set(ct, 33);
  if (!(await store.put(kb.path, block))) throw new ShareError('share locator collision');
  const n = await writeEnvelope(store, s, hour, item, { burn, from, to: recipient.handle });
  const entry = { kind: 'recipient', s: b32(s), hour, n, to: recipient.handle, created: Math.floor(Date.now() / 1000), name: item.name ?? '' };
  return { url: `${origin}/#r1.${hour}.${kb.id}`, entry };
}

// ── Opening and revoking ────────────────────────────────────────────────────

export function parseShareFragment(fragment) {
  const m = /^#?(l1|r1)\.(\d{1,10})\.([a-z2-7]+)$/.exec(fragment.trim());
  if (!m) return null;
  return { kind: m[1] === 'l1' ? 'link' : 'recipient', hour: Number(m[2]), value: m[3] };
}

/**
 * Opens a share from its URL fragment. Recipient shares need the vault's
 * identity. Returns { item, meta, s }.
 */
export async function openShare(store, fragment, identity = null) {
  const f = parseShareFragment(fragment);
  if (!f) throw new ShareError('This is not a valid share link');
  let s;
  if (f.kind === 'link') {
    s = b32decode(f.value);
    if (s.length !== 32) throw new ShareError('This share link is invalid');
  } else {
    if (!identity) throw new ShareError('Sign in to open a share sent to your handle');
    const block = await store.get(`e/${f.hour}/${f.value}`);
    if (!block) throw new ShareError('This share has expired or was revoked');
    const k = identityKeys(identity);
    const ephPk = block.slice(1, 33);
    const ct = block.slice(33, 33 + mlkem.CT_BYTES);
    let ssx;
    try { ssx = await x25519(k.xsk, ephPk); } catch { throw new ShareError('This share was not sent to you'); }
    s = await hybridSecret(ssx, mlkem.decaps(k.dk, ct), ephPk, ct, k.xpk, k.ek);
    if ((await keyBlockRef(s, f.hour)).id !== f.value) throw new ShareError('This share was not sent to you');
  }
  const { meta, payload } = await readEnvelope(store, s, f.hour);
  return { item: payload, meta, s, hour: f.hour, kind: f.kind };
}

/** Deletes a share. Works for the sender (from a vault entry) and for any holder of `s`. */
export async function deleteShare(store, { kind, s, hour, n }) {
  const sb = typeof s === 'string' ? b32decode(s) : s;
  const refs = await envelopeRefs(sb, hour, n);
  if (kind === 'recipient') refs.unshift(await keyBlockRef(sb, hour));
  await deleteAll(store, refs);
}
