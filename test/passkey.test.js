import {
  wrapDeviceKey, unwrapDeviceKey, escrowDeviceKey, recoverDeviceKey, sealSecrets, openSecrets,
  unwrapLegacyAccountKey, PasskeyError,
} from '../app/src/passkey.js';
import { aesKey, hkdf, random, seal } from '../core/crypto.js';
import { b64, concat, utf8 } from '../core/encoding.js';
import { eq, ok } from '../tools/check.js';

async function rejects(p) {
  try { await p; } catch (e) { ok(e instanceof PasskeyError, e.message); return; }
  throw new Error('expected PasskeyError');
}

const SALT = 'ab'.repeat(16), OTHER = 'cd'.repeat(16);

export async function everyPasskeyUnwrapsTheSameDeviceKey() {
  const dk = random(32), face = random(32), yubikey = random(32);
  const a = await wrapDeviceKey(face, dk, SALT), b = await wrapDeviceKey(yubikey, dk, SALT);
  eq(await unwrapDeviceKey(face, a, SALT), dk);
  eq(await unwrapDeviceKey(yubikey, b, SALT), dk);
  await rejects(unwrapDeviceKey(yubikey, a, SALT));      // each record only opens with its own authenticator
  await rejects(unwrapDeviceKey(face, a, OTHER));        // bound to this account's salt
}

export async function escrowNeedsTheVaultKey() {
  const dk = random(32), encRaw = random(32);
  const rec = await escrowDeviceKey(encRaw, dk, SALT);
  eq(await recoverDeviceKey(encRaw, rec, SALT), dk);
  eq(await recoverDeviceKey(random(32), rec, SALT), null);
  eq(await recoverDeviceKey(encRaw, rec, OTHER), null);
  eq(await recoverDeviceKey(encRaw, undefined, SALT), null);
}

export async function sealedSecretsWithAndWithoutVaultKeys() {
  const dk = random(32), accountKey = random(16), keys = { loc: random(32), encRaw: random(32) };
  const keyOnly = await openSecrets(dk, await sealSecrets(dk, accountKey, null, SALT), SALT);
  eq(keyOnly.accountKey, accountKey);
  eq(keyOnly.keys, undefined);
  const quick = await openSecrets(dk, await sealSecrets(dk, accountKey, keys, SALT), SALT);
  eq(quick.accountKey, accountKey);
  eq(quick.keys.loc, keys.loc);
  eq(quick.keys.encRaw, keys.encRaw);
  await rejects(openSecrets(random(32), await sealSecrets(dk, accountKey, null, SALT), SALT));
  await rejects(openSecrets(dk, await sealSecrets(dk, accountKey, keys, SALT), OTHER));
}

export async function domainsAreSeparated() {
  // The same secret used as PRF output, vault key and device key never opens another layer's record.
  const x = random(32);
  const wrapped = await wrapDeviceKey(x, random(32), SALT);
  eq(await recoverDeviceKey(x, wrapped, SALT), null);
  await rejects(openSecrets(x, wrapped, SALT));
}

export async function legacyRecordsStillOpen() {
  // Version 1: the Account Key wrapped directly under the PRF output.
  const prf = random(32), accountKey = random(16), nonce = random(12);
  const key = await aesKey(await hkdf(prf, 'rspm/v1', 'device-wrap'));
  const rec = { nonce: b64(nonce), ct: b64(await seal(key, nonce, accountKey, concat(utf8('rspm/v1/device'), utf8(SALT)))) };
  eq(await unwrapLegacyAccountKey(prf, rec, SALT), accountKey);
  await rejects(unwrapLegacyAccountKey(random(32), rec, SALT));
}
