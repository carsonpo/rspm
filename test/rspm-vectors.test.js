// Checks the implementation against the committed RSPM known answers.
import { readFileSync } from 'node:fs';
import { concat, hex, unhex } from '../core/encoding.js';
import { formatAccountKey, parseAccountKey, salt, subkeys, deriveKeys } from '../core/kdf.js';
import { locate } from '../core/block.js';
import { retained } from '../core/vault.js';
import { handlePath, hybridSecret, fingerprint } from '../core/share.js';
import { eq } from '../tools/check.js';

const V = JSON.parse(readFileSync(new URL('./vectors/rspm.json', import.meta.url), 'utf8'));

export async function accountKeys() {
  for (const c of V.account_key) {
    eq(await formatAccountKey(unhex(c.bytes)), c.display);
    eq(hex(await parseAccountKey(c.display)), c.bytes);
  }
}

export async function salts() {
  for (const c of V.salt) eq(hex(await salt(c.username)), c.salt, c.username);
}

export async function subkeyDerivation() {
  for (const c of V.subkeys) {
    const s = await subkeys(unhex(c.argon2_output), unhex(c.account_key));
    eq([hex(s.loc), hex(s.encRaw)], [c.loc_key, c.enc_key]);
  }
  const d = V.derive_protocol_params;
  const s = await deriveKeys(d.username, d.password, unhex(d.account_key));
  eq([hex(s.loc), hex(s.encRaw)], [d.loc_key, d.enc_key]);
}

export async function locators() {
  for (const c of V.locators) {
    const l = await locate(unhex(c.key), unhex(c.label));
    eq([hex(l.token), l.id], [c.token, c.locator], c.desc);
  }
}

export function retainedHeads() {
  for (const c of V.retained) eq([...retained(c.G)].sort((a, b) => a - b), c.R, `G=${c.G}`);
}

export async function handlesAndHybrid() {
  for (const c of V.handles) eq(await handlePath(c.handle), c.path);
  const h = V.hybrid;
  const s = await hybridSecret(...[h.ss_x, h.ss_k, h.eph_pk, h.ct_k, h.x_pk, h.ek].map(unhex));
  eq(hex(s), h.s);
  eq(await fingerprint(unhex(h.x_pk), unhex(h.ek)), h.fingerprint);
}
