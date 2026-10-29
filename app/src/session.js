// Session state: credentials, the open vault, saving, and locking.

import { signal } from './ui.js';
import { toast } from './components.js';
import * as idb from './idb.js';
import { Store } from '../../core/store.js';
import { deriveKeys, salt } from '../../core/kdf.js';
import { Vault, VaultNotFoundError, RollbackError, emptyDoc } from '../../core/vault.js';
import { hex, b64, b64decode } from '../../core/encoding.js';
import { enroll, unlock, PasskeyError, passkeyLabel } from './passkey.js';

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

export async function deviceRecord(username) {
  if (!username.trim()) return null;
  return (await idb.get(deviceKey(hex(await salt(username))))) ?? null;
}

export const lastUsername = () => idb.get('last-username');

async function remember(saltHex, username, { accountKey, rememberKey, gen }) {
  const rec = (await idb.get(deviceKey(saltHex))) ?? {};
  const next = { ...rec, maxGen: Math.max(rec.maxGen ?? 0, gen) };
  if (rememberKey === true) { next.akey = b64(accountKey); delete next.passkey; }
  if (rememberKey === false) { delete next.akey; delete next.passkey; }
  await idb.set(deviceKey(saltHex), next);
  if (rememberKey === true) await idb.set('last-username', username);
  if (rememberKey === false && (await idb.get('last-username')) === username) await idb.del('last-username');
}

function start(username, vault, accountKey, saltHex, extra = {}) {
  session.value = { username, vault, accountKey, saltHex, ...extra };
  doc.value = vault.doc;
}

/**
 * Signs in. `accountKey` is null to use this device's remembered key.
 * `rememberKey` is true/false to change what the device remembers, or
 * undefined to leave it alone.
 */
export async function signIn({ username, password, accountKey, rememberKey, allowRollback = false }, onStep = () => {}) {
  const saltHex = hex(await salt(username));
  const rec = await idb.get(deviceKey(saltHex));
  let key = accountKey ?? (rec?.akey ? b64decode(rec.akey) : null);
  if (!key && rec?.passkey) {
    // Ask the authenticator first, while the click that started this still counts as a user gesture.
    onStep(`Waiting for ${passkeyLabel(rec.passkey)}`);
    try { key = await unlock(rec.passkey, saltHex); } catch (err) {
      throw new SignInError(err instanceof PasskeyError ? `${err.message}. You can sign in with your Account Key instead.` : err.message);
    }
  }
  if (!key) throw new SignInError('Enter your Account Key');
  onStep('Deriving your keys');
  const keys = await deriveKeys(username, password, key);
  onStep('Finding your vault');
  let vault;
  try {
    vault = await Vault.open(store, keys, { minGen: allowRollback ? 0 : rec?.maxGen ?? 0 });
  } catch (err) {
    if (err instanceof VaultNotFoundError) {
      throw new SignInError('Nothing matches that username, password and Account Key. Check each one — for your privacy, rspm can’t tell which is wrong.');
    }
    throw err;
  }
  await remember(saltHex, username, { accountKey: key, rememberKey, gen: vault.gen });
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

/** Replaces the session's vault (after a credential change). */
export async function replaceVault(username, vault, accountKey, rememberKey) {
  const saltHex = hex(await salt(username));
  const old = session.peek();
  if (old && old.saltHex !== saltHex) await idb.del(deviceKey(old.saltHex));
  await remember(saltHex, username, { accountKey, rememberKey, gen: vault.gen });
  start(username, vault, accountKey, saltHex);
}

/** Registers a passkey for this device and stores the Account Key wrapped by it. Call from a user gesture. */
export async function protectWithPasskey() {
  const s = session.peek();
  if (!s) return;
  const record = await enroll(s.accountKey, s.saltHex);
  const rec = (await idb.get(deviceKey(s.saltHex))) ?? {};
  delete rec.akey;
  await idb.set(deviceKey(s.saltHex), { ...rec, passkey: record, maxGen: Math.max(rec.maxGen ?? 0, s.vault.gen) });
  await idb.set('last-username', s.username);
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
