import { wrapAccountKey, unwrapAccountKey, PasskeyError } from '../app/src/passkey.js';
import { random } from '../core/crypto.js';
import { eq, ok } from '../tools/check.js';

async function rejects(p) {
  try { await p; } catch (e) { ok(e instanceof PasskeyError, e.message); return; }
  throw new Error('expected PasskeyError');
}

export async function wrapRoundTrip() {
  const prf = random(32), key = random(16), salt = 'ab'.repeat(16);
  const rec = await wrapAccountKey(prf, key, salt);
  eq(await unwrapAccountKey(prf, rec, salt), key);
}

export async function wrongAuthenticatorOrAccountFails() {
  const prf = random(32), key = random(16), salt = 'ab'.repeat(16);
  const rec = await wrapAccountKey(prf, key, salt);
  await rejects(unwrapAccountKey(random(32), rec, salt));          // a different passkey
  await rejects(unwrapAccountKey(prf, rec, 'cd'.repeat(16)));       // bound to this account's salt
}
