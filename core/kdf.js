// Credentials and key derivation (PROTOCOL §3).

import { b32, b32decode, concat, equal, utf8 } from './encoding.js';
import { aesKey, hkdf, random, sha256 } from './crypto.js';
import { argon2id } from './argon2.js';

export const ARGON2 = Object.freeze({ m: 65536, t: 3, p: 1, len: 32 });

export const normalizeUsername = (u) => utf8(u.trim().normalize('NFKC').toLowerCase());
export const normalizePassword = (p) => utf8(p.normalize('NFC'));

// ── Account Key (§3.2) ──────────────────────────────────────────────────────

export async function accountKeyChecksum(k) {
  return (await sha256('rspm/v1/akey', k)).slice(0, 2);
}

export async function formatAccountKey(k) {
  const body = b32(concat(k, await accountKeyChecksum(k))).toUpperCase();
  return 'RSPM1-' + body.match(/.{1,4}/g).join('-');
}

export async function generateAccountKey() {
  const bytes = random(16);
  return { bytes, display: await formatAccountKey(bytes) };
}

export class AccountKeyError extends Error {}

export async function parseAccountKey(input) {
  let s = input.replace(/[\s-]/g, '').toLowerCase();
  if (!s.startsWith('rspm1')) throw new AccountKeyError('Account Keys start with RSPM1-');
  s = s.slice(5);
  let raw;
  try { raw = b32decode(s); } catch { throw new AccountKeyError('That Account Key contains invalid characters'); }
  if (raw.length !== 18) throw new AccountKeyError('That Account Key is the wrong length');
  const k = raw.slice(0, 16);
  if (!equal(raw.slice(16), await accountKeyChecksum(k))) {
    throw new AccountKeyError('That Account Key has a typo — the checksum does not match');
  }
  return k;
}

// ── Derivation (§3.3) ───────────────────────────────────────────────────────

export async function salt(username) {
  return (await sha256('rspm/v1/salt', normalizeUsername(username))).slice(0, 16);
}

/** Subkeys from the Argon2id output and Account Key. */
export async function subkeys(pwKey, accountKey) {
  const ikm = concat(pwKey, accountKey);
  const loc = await hkdf(ikm, 'rspm/v1', 'loc');
  const encRaw = await hkdf(ikm, 'rspm/v1', 'enc');
  return { loc, enc: await aesKey(encRaw), encRaw };
}

export async function deriveKeys(username, password, accountKey, params = ARGON2) {
  const pwKey = await argon2id(normalizePassword(password), await salt(username), params);
  const keys = await subkeys(pwKey, accountKey);
  pwKey.fill(0);
  return keys;
}
