// Session state: credentials, the open vault, saving, and locking.

import { signal } from './ui.js';
import { toast } from './components.js';
import * as idb from './idb.js';
import { Store } from '../../core/store.js';
import { deriveKeys, salt } from '../../core/kdf.js';
import { Vault, VaultNotFoundError, RollbackError, emptyDoc } from '../../core/vault.js';
import { hex, b64, b64decode } from '../../core/encoding.js';
import { aesKey, random } from '../../core/crypto.js';
import {
  assert, enroll, PasskeyError, passkeyLabel, wrapDeviceKey, unwrapDeviceKey, escrowDeviceKey, recoverDeviceKey,
  sealSecrets, openSecrets, unwrapLegacyAccountKey,
} from './passkey.js';

export const config = globalThis.RSPM_CONFIG ?? {
  api: location.origin, blocks: `${location.origin}/v1`, link: location.origin, version: 'dev',
};
export const store = new Store({ api: config.api, blocks: config.blocks });

/** { username, vault, accountKey, saltHex, rollback } while unlocked; null when locked. */
export const session = signal(null);
/** The vault document (reactive snapshot of vault.doc). */
export const doc = signal(null);
/** { done, total } while a save is in flight. */
export const saving = signal(null);

export class SignInError extends Error {}

const deviceKey = (saltHex) => `device:${saltHex}`;

// Fields of a device record that belong to passkey protection (§10.2). `passkey` is the version 1 form.
const PROTECTION = ['passkey', 'passkeys', 'prfSalt', 'dk', 'sealed', 'quick'];
const strip = (rec) => { for (const f of PROTECTION) delete rec[f]; return rec; };

export async function deviceRecord(username) {
  if (!username.trim()) return null;
  return (await idb.get(deviceKey(hex(await salt(username))))) ?? null;
}

/** Whether a device record holds an Account Key, protected or not. */
export const remembersKey = (rec) => !!(rec?.akey || rec?.passkey || rec?.passkeys?.length);
/** Whether a device record unlocks with a passkey alone. */
export const quickUnlock = (rec) => !!(rec?.quick && rec.passkeys?.length);

export const lastUsername = () => idb.get('last-username');

async function remember(saltHex, username, { accountKey, rememberKey, gen }) {
  const rec = (await idb.get(deviceKey(saltHex))) ?? {};
  const next = { ...rec, maxGen: Math.max(rec.maxGen ?? 0, gen) };
  if (rememberKey === true) { next.akey = b64(accountKey); strip(next); }
  if (rememberKey === false) { delete next.akey; strip(next); }
  await idb.set(deviceKey(saltHex), next);
  if (rememberKey === true) await idb.set('last-username', username);
  if (rememberKey === false && (await idb.get('last-username')) === username) await idb.del('last-username');
}

function start(username, vault, accountKey, saltHex, extra = {}) {
  session.value = { username, vault, accountKey, saltHex, ...extra };
  doc.value = vault.doc;
}

const vaultKeys = async ({ loc, encRaw }) => ({ loc, enc: await aesKey(encRaw), encRaw });

/** Reads what this device's passkeys protect: { accountKey, keys?, legacyPrf? }. */
async function unlockWithPasskey(rec, saltHex) {
  if (rec.passkeys?.length) {
    const { id, prf } = await assert(rec.passkeys.map((p) => p.id), b64decode(rec.prfSalt));
    const pk = rec.passkeys.find((p) => p.id === id);
    if (!pk) throw new PasskeyError('That passkey isn’t registered on this device');
    return openSecrets(await unwrapDeviceKey(prf, pk, saltHex), rec.sealed, saltHex);
  }
  const { prf } = await assert([rec.passkey.id], b64decode(rec.passkey.salt));
  return { accountKey: await unwrapLegacyAccountKey(prf, rec.passkey, saltHex), legacyPrf: prf };
}

/**
 * Writes passkey protection for an open vault. `dk` is the device key, `quick`
 * whether the vault keys are sealed too, `passkeys` the wrapped records.
 */
async function writeProtection(saltHex, { accountKey, keys, dk, prfSalt, passkeys, quick, maxGen }) {
  const rec = strip((await idb.get(deviceKey(saltHex))) ?? {});
  delete rec.akey;
  await idb.set(deviceKey(saltHex), {
    ...rec,
    maxGen: Math.max(rec.maxGen ?? 0, maxGen ?? 0),
    prfSalt: b64(prfSalt),
    passkeys,
    dk: await escrowDeviceKey(keys.encRaw, dk, saltHex),
    sealed: await sealSecrets(dk, accountKey, quick ? keys : null, saltHex),
    quick,
  });
}

/**
 * Signs in. `accountKey` is null to use this device's remembered key.
 * `rememberKey` is true/false to change what the device remembers, or
 * undefined to leave it alone. `password` may be empty when this device has
 * password-free unlock.
 */
export async function signIn({ username, password, accountKey, rememberKey, allowRollback = false }, onStep = () => {}) {
  const saltHex = hex(await salt(username));
  const rec = await idb.get(deviceKey(saltHex));
  let key = accountKey ?? (rec?.akey ? b64decode(rec.akey) : null);
  let stored = null;
  if (!key && (rec?.passkeys?.length || rec?.passkey)) {
    // Ask the authenticator first, while the click that started this still counts as a user gesture.
    onStep(`Waiting for ${passkeyLabel(rec.passkeys ?? rec.passkey)}`);
    try { stored = await unlockWithPasskey(rec, saltHex); } catch (err) {
      throw new SignInError(err instanceof PasskeyError ? `${err.message}. You can sign in with your Account Key instead.` : err.message);
    }
    key = stored.accountKey;
  }
  if (!key) throw new SignInError('Enter your Account Key');
  if (!password && !stored?.keys) throw new SignInError('Enter your password');
  onStep(password ? 'Deriving your keys' : 'Unlocking');
  const keys = password ? await deriveKeys(username, password, key) : await vaultKeys(stored.keys);
  onStep('Finding your vault');
  let vault;
  try {
    vault = await Vault.open(store, keys, { minGen: allowRollback ? 0 : rec?.maxGen ?? 0 });
  } catch (err) {
    if (err instanceof VaultNotFoundError) {
      throw new SignInError(password
        ? 'Nothing matches that username, password and Account Key. Check each one — for your privacy, rspm can’t tell which is wrong.'
        : 'The keys saved on this device no longer open a vault. Your credentials may have changed on another device — sign in with your password.');
    }
    throw err;
  }
  await remember(saltHex, username, { accountKey: key, rememberKey, gen: vault.gen });
  if (stored?.legacyPrf && rememberKey === undefined) {
    // Upgrade a version 1 record while the authenticator's output is at hand.
    const dk = random(32);
    const pk = { id: rec.passkey.id, kind: rec.passkey.kind, created: rec.passkey.created, ...(await wrapDeviceKey(stored.legacyPrf, dk, saltHex)) };
    await writeProtection(saltHex, { accountKey: key, keys, dk, prfSalt: b64decode(rec.passkey.salt), passkeys: [pk], quick: false });
  }
  start(username, vault, key, saltHex, { rollback: allowRollback && rec?.maxGen > vault.gen });
}

export async function createAccount({ username, password, accountKey, rememberKey }, onStep = () => {}, onProgress) {
  const saltHex = hex(await salt(username));
  onStep('Deriving your keys');
  const keys = await deriveKeys(username, password, accountKey);
  onStep('Creating your vault');
  const vault = await Vault.create(store, keys, emptyDoc(), onProgress);
  await remember(saltHex, username, { accountKey, rememberKey, gen: vault.gen });
  start(username, vault, accountKey, saltHex);
}

/** Saves a change to the vault. Returns true on success. */
export async function save(change, message = 'Saved') {
  const s = session.peek();
  if (!s) return false;
  saving.value = { done: 0, total: 1 };
  try {
    await s.vault.update(change, (done, total) => { saving.value = { done, total }; });
    doc.value = s.vault.doc;
    await remember(s.saltHex, s.username, { gen: s.vault.gen });
    if (message) toast(message);
    return true;
  } catch (err) {
    if (err instanceof RollbackError) toast('The server is hiding newer changes — saving is disabled', { tone: 'danger', ms: 6000 });
    else toast(`Couldn’t save: ${err.message}`, { tone: 'danger', ms: 6000 });
    return false;
  } finally {
    saving.value = null;
  }
}

/** Pulls changes made on other devices. */
export async function refresh() {
  const s = session.peek();
  if (!s || saving.peek()) return;
  try {
    await s.vault.refresh();
    doc.value = s.vault.doc;
    await remember(s.saltHex, s.username, { gen: s.vault.gen });
  } catch (err) {
    if (err instanceof RollbackError) toast('The server returned an older vault — showing what this device last saw', { tone: 'danger' });
  }
}

/**
 * Replaces the session's vault after a credential change. With the same
 * username, whatever this device remembers is carried over to the new key and
 * vault keys (passkeys stay registered). A new username starts a new device
 * record, remembered plainly only if `rememberPlainly`.
 */
export async function replaceVault(username, vault, accountKey, rememberPlainly) {
  const saltHex = hex(await salt(username));
  const old = session.peek();
  const rec = await idb.get(deviceKey(saltHex));
  if (old && old.saltHex === saltHex && rec) {
    // The new vault's revisions start again from its own first head.
    const next = { ...rec, maxGen: vault.gen };
    if (next.akey) next.akey = b64(accountKey);
    const dk = rec.passkeys?.length && await recoverDeviceKey(old.vault.keys.encRaw, rec.dk, saltHex);
    if (dk) {
      next.dk = await escrowDeviceKey(vault.keys.encRaw, dk, saltHex);
      next.sealed = await sealSecrets(dk, accountKey, rec.quick ? vault.keys : null, saltHex);
    } else strip(next);
    await idb.set(deviceKey(saltHex), next);
  } else {
    if (old) await idb.del(deviceKey(old.saltHex));
    await remember(saltHex, username, { accountKey, rememberKey: rememberPlainly ? true : undefined, gen: vault.gen });
  }
  start(username, vault, accountKey, saltHex);
}

/**
 * Registers another passkey or security key for this device and remembers the
 * Account Key under it. Call from a user gesture.
 */
export async function addPasskey() {
  const s = session.peek();
  if (!s) return;
  const rec = (await idb.get(deviceKey(s.saltHex))) ?? {};
  // Existing passkeys stay valid only if this session can recover the device key they wrap.
  const current = rec.passkeys?.length ? await recoverDeviceKey(s.vault.keys.encRaw, rec.dk, s.saltHex) : null;
  const keep = current ? rec.passkeys : [];
  const dk = current ?? random(32);
  const prfSalt = current ? b64decode(rec.prfSalt) : random(32);
  const { record, prf } = await enroll(prfSalt, keep.map((p) => p.id));
  const passkeys = [...keep, { ...record, ...(await wrapDeviceKey(prf, dk, s.saltHex)) }];
  await writeProtection(s.saltHex, { accountKey: s.accountKey, keys: s.vault.keys, dk, prfSalt, passkeys, quick: !!(current && rec.quick), maxGen: s.vault.gen });
  await idb.set('last-username', s.username);
}

/** Removes one passkey. Removing the last one forgets the Account Key on this device. */
export async function removePasskey(id) {
  const s = session.peek();
  if (!s) return;
  const rec = (await idb.get(deviceKey(s.saltHex))) ?? {};
  const passkeys = (rec.passkeys ?? []).filter((p) => p.id !== id);
  if (passkeys.length) await idb.set(deviceKey(s.saltHex), { ...rec, passkeys });
  else await forgetDevice();
}

/** Turns password-free unlock on or off: whether the vault keys are sealed alongside the Account Key. */
export async function setQuickUnlock(on) {
  const s = session.peek();
  if (!s) return;
  const rec = (await idb.get(deviceKey(s.saltHex))) ?? {};
  const dk = rec.passkeys?.length && await recoverDeviceKey(s.vault.keys.encRaw, rec.dk, s.saltHex);
  if (!dk) throw new PasskeyError('Add a passkey or security key first');
  await idb.set(deviceKey(s.saltHex), { ...rec, sealed: await sealSecrets(dk, s.accountKey, on ? s.vault.keys : null, s.saltHex), quick: on });
}

/** Remembers the Account Key on this device without a passkey. */
export async function rememberPlain() {
  const s = session.peek();
  if (s) await remember(s.saltHex, s.username, { accountKey: s.accountKey, rememberKey: true, gen: s.vault.gen });
}

export async function forgetDevice() {
  const s = session.peek();
  if (s) await remember(s.saltHex, s.username, { rememberKey: false, gen: s.vault.gen });
}

export function lock() {
  session.value = null;
  doc.value = null;
}
