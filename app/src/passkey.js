// Protecting what this device remembers with passkeys and security keys
// (PROTOCOL §10.2).
//
// The WebAuthn PRF extension (CTAP2 hmac-secret) returns a secret that the
// authenticator only releases after user verification — Touch ID, Face ID,
// Windows Hello, or a YubiKey touch + PIN. Each registered authenticator wraps
// the same random device key, and the device key seals the Account Key (and,
// with password-free unlock, the vault keys). No server is involved:
// assertions are never sent anywhere, only the PRF output is used, locally.

import { b64, b64decode, concat, utf8 } from '../../core/encoding.js';
import { aesKey, hkdf, open, random, seal } from '../../core/crypto.js';

export class PasskeyError extends Error {}

/** Whether this context can use WebAuthn at all (https or localhost, not file://). */
export function passkeysAvailable() {
  return typeof window !== 'undefined' && window.isSecureContext && location.protocol !== 'file:' &&
    typeof PublicKeyCredential !== 'undefined' && !!navigator.credentials;
}

/** true / false if the browser reports PRF support, null if it can't say. */
export async function prfSupported() {
  if (!passkeysAvailable()) return false;
  try {
    const caps = await PublicKeyCredential.getClientCapabilities?.();
    if (caps && 'extension:prf' in caps) return !!caps['extension:prf'];
  } catch { /* fall through */ }
  return null;
}

// ── Wrapping (pure; tested in Node) ─────────────────────────────────────────

async function lockWith(secret, info, label, data, saltHex) {
  const nonce = random(12);
  const key = await aesKey(await hkdf(secret, 'rspm/v1', info));
  return { nonce: b64(nonce), ct: b64(await seal(key, nonce, data, concat(utf8(`rspm/v1/${label}`), utf8(saltHex)))) };
}

async function unlockWith(secret, info, label, { nonce, ct }, saltHex) {
  const key = await aesKey(await hkdf(secret, 'rspm/v1', info));
  return open(key, b64decode(nonce), b64decode(ct), concat(utf8(`rspm/v1/${label}`), utf8(saltHex)));
}

/** Wraps the device key under one authenticator's PRF output. */
export const wrapDeviceKey = (prf, dk, saltHex) => lockWith(prf, 'device-wrap', 'device-key', dk, saltHex);

export async function unwrapDeviceKey(prf, rec, saltHex) {
  const dk = await unlockWith(prf, 'device-wrap', 'device-key', rec, saltHex);
  if (!dk || dk.length !== 32) throw new PasskeyError('This passkey doesn’t unlock the key stored on this device');
  return dk;
}

/** A copy of the device key under the vault key, so an unlocked session can add passkeys without touching the others. */
export const escrowDeviceKey = (encRaw, dk, saltHex) => lockWith(encRaw, 'device-escrow', 'device-escrow', dk, saltHex);

export async function recoverDeviceKey(encRaw, rec, saltHex) {
  const dk = rec && await unlockWith(encRaw, 'device-escrow', 'device-escrow', rec, saltHex);
  return dk?.length === 32 ? dk : null;
}

/** Seals the Account Key, plus the vault keys when `keys` is given (password-free unlock). */
export function sealSecrets(dk, accountKey, keys, saltHex) {
  const data = keys ? concat(accountKey, keys.loc, keys.encRaw) : accountKey;
  return lockWith(dk, 'device-secrets', 'device-secrets', data, saltHex);
}

/** Returns { accountKey, keys? }, where keys is { loc, encRaw } for password-free unlock. */
export async function openSecrets(dk, rec, saltHex) {
  const d = await unlockWith(dk, 'device-secrets', 'device-secrets', rec, saltHex);
  if (d?.length === 16) return { accountKey: d };
  if (d?.length === 80) return { accountKey: d.slice(0, 16), keys: { loc: d.slice(16, 48), encRaw: d.slice(48) } };
  throw new PasskeyError('The key stored on this device is damaged');
}

/** Version 1 records (a single passkey wrapping the Account Key directly). Read only, for migration. */
export async function unwrapLegacyAccountKey(prf, { nonce, ct }, saltHex) {
  const key = await aesKey(await hkdf(prf, 'rspm/v1', 'device-wrap'));
  const k = await open(key, b64decode(nonce), b64decode(ct), concat(utf8('rspm/v1/device'), utf8(saltHex)));
  if (!k || k.length !== 16) throw new PasskeyError('This passkey doesn’t unlock the key stored on this device');
  return k;
}

// ── WebAuthn ────────────────────────────────────────────────────────────────

function explain(err) {
  if (err instanceof PasskeyError) return err;
  if (err?.name === 'NotAllowedError') return new PasskeyError('The passkey request was cancelled or timed out');
  if (err?.name === 'InvalidStateError') return new PasskeyError('This authenticator is already registered');
  if (err?.name === 'SecurityError') return new PasskeyError('Passkeys aren’t available on this address');
  return new PasskeyError(err?.message ?? String(err));
}

/**
 * Asks any of `ids` (b64 credential ids) for its PRF output over `prfSalt`.
 * Returns { id, prf } for whichever authenticator answered.
 */
export async function assert(ids, prfSalt) {
  let cred;
  try {
    cred = await navigator.credentials.get({
      publicKey: {
        challenge: random(32),
        rpId: location.hostname,
        allowCredentials: ids.map((id) => ({ type: 'public-key', id: b64decode(id) })),
        userVerification: 'required',
        timeout: 120000,
        extensions: { prf: { eval: { first: prfSalt } } },
      },
    });
  } catch (err) { throw explain(err); }
  const first = cred?.getClientExtensionResults?.().prf?.results?.first;
  if (!first) throw new PasskeyError('This authenticator didn’t return a key. It may not support the PRF extension.');
  return { id: b64(new Uint8Array(cred.rawId)), prf: new Uint8Array(first) };
}

/**
 * Registers a new passkey. Must be called from a user gesture. `exclude` lists
 * credential ids already registered, so the same key can't be added twice.
 * Returns { record: { id, kind, created }, prf }.
 */
export async function enroll(prfSalt, exclude = []) {
  if (!passkeysAvailable()) throw new PasskeyError('Passkeys need a secure (https) connection');
  let cred;
  try {
    cred = await navigator.credentials.create({
      publicKey: {
        rp: { name: 'rspm', id: location.hostname },
        // Deliberately generic: passkey managers display this, and the
        // username is one of the three secrets.
        user: { id: random(16), name: 'rspm Account Key', displayName: 'rspm Account Key' },
        challenge: random(32),
        pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -8 }, { type: 'public-key', alg: -257 }],
        excludeCredentials: exclude.map((id) => ({ type: 'public-key', id: b64decode(id) })),
        authenticatorSelection: { userVerification: 'required', residentKey: 'discouraged' },
        attestation: 'none',
        timeout: 120000,
        extensions: { prf: { eval: { first: prfSalt } } },
      },
    });
  } catch (err) { throw explain(err); }
  const ext = cred.getClientExtensionResults?.().prf;
  if (ext?.enabled === false) {
    throw new PasskeyError('This authenticator can’t protect keys (no PRF support). Try Touch ID, Face ID, Windows Hello or a YubiKey 5.');
  }
  const id = b64(new Uint8Array(cred.rawId));
  // Some authenticators return the PRF output at registration; others need a second touch.
  const first = ext?.results?.first;
  const prf = first ? new Uint8Array(first) : (await assert([id], prfSalt)).prf;
  return {
    record: { id, kind: cred.authenticatorAttachment === 'cross-platform' ? 'security-key' : 'platform', created: Math.floor(Date.now() / 1000) },
    prf,
  };
}

export const kindLabel = (kind) => (kind === 'security-key' ? 'Security key' : 'Touch ID, Face ID or Windows Hello');

/** How to describe "the thing you'll be asked for" given the registered passkeys. */
export function passkeyLabel(list) {
  const kinds = new Set((Array.isArray(list) ? list : [list]).filter(Boolean).map((p) => p.kind));
  if (kinds.size > 1) return 'a passkey or security key';
  return kinds.has('security-key') ? 'your security key' : 'Touch ID, Face ID or Windows Hello';
}
