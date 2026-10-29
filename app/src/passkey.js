// Protecting the remembered Account Key with a passkey or security key
// (PROTOCOL §10.2).
//
// The WebAuthn PRF extension (CTAP2 hmac-secret) returns a secret that the
// authenticator only releases after user verification — Touch ID, Face ID,
// Windows Hello, or a YubiKey touch + PIN. That secret wraps the Account Key
// stored on this device. No server is involved: assertions are never sent
// anywhere, only the PRF output is used, locally.

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

const aad = (saltHex) => concat(utf8('rspm/v1/device'), utf8(saltHex));

async function wrapKey(prf) {
  return aesKey(await hkdf(prf, 'rspm/v1', 'device-wrap'));
}

/** Encrypts the Account Key under a PRF output, bound to this account's salt. */
export async function wrapAccountKey(prf, accountKey, saltHex) {
  const nonce = random(12);
  const ct = await seal(await wrapKey(prf), nonce, accountKey, aad(saltHex));
  return { nonce: b64(nonce), ct: b64(ct) };
}

export async function unwrapAccountKey(prf, { nonce, ct }, saltHex) {
  const k = await open(await wrapKey(prf), b64decode(nonce), b64decode(ct), aad(saltHex));
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

async function evaluate(credentialId, prfSalt) {
  let cred;
  try {
    cred = await navigator.credentials.get({
      publicKey: {
        challenge: random(32),
        rpId: location.hostname,
        allowCredentials: [{ type: 'public-key', id: credentialId }],
        userVerification: 'required',
        timeout: 120000,
        extensions: { prf: { eval: { first: prfSalt } } },
      },
    });
  } catch (err) { throw explain(err); }
  const first = cred?.getClientExtensionResults?.().prf?.results?.first;
  if (!first) throw new PasskeyError('This authenticator didn’t return a key. It may not support the PRF extension.');
  return new Uint8Array(first);
}

/**
 * Registers a new passkey and wraps `accountKey` with it. Must be called from a
 * user gesture. Returns the record to store in the device entry.
 */
export async function enroll(accountKey, saltHex) {
  if (!passkeysAvailable()) throw new PasskeyError('Passkeys need a secure (https) connection');
  const prfSalt = random(32);
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
  const id = new Uint8Array(cred.rawId);
  // Some authenticators return the PRF output at registration; others need a second touch.
  const first = ext?.results?.first;
  const prf = first ? new Uint8Array(first) : await evaluate(id, prfSalt);
  return {
    id: b64(id),
    salt: b64(prfSalt),
    kind: cred.authenticatorAttachment === 'cross-platform' ? 'security-key' : 'platform',
    created: Math.floor(Date.now() / 1000),
    ...(await wrapAccountKey(prf, accountKey, saltHex)),
  };
}

/** Asks the authenticator for its PRF output and unwraps the Account Key. */
export async function unlock(record, saltHex) {
  const prf = await evaluate(b64decode(record.id), b64decode(record.salt));
  return unwrapAccountKey(prf, record, saltHex);
}

export const passkeyLabel = (record) => (record?.kind === 'security-key' ? 'your security key' : 'Touch ID, Face ID or Windows Hello');
