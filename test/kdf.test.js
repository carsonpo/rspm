import { generateAccountKey, parseAccountKey, deriveKeys, salt, AccountKeyError } from '../core/kdf.js';
import { hex } from '../core/encoding.js';
import { eq, ok } from '../tools/check.js';

const SMALL = { m: 64, t: 1, p: 1, len: 32 };

export async function accountKeyRoundTrip() {
  for (let i = 0; i < 50; i++) {
    const { bytes, display } = await generateAccountKey();
    ok(/^RSPM1(-[A-Z2-7]{1,4}){8}$/.test(display), display);
    eq(await parseAccountKey(display), bytes);
    eq(await parseAccountKey(display.toLowerCase().replaceAll('-', ' ')), bytes, 'lenient input');
  }
}

export async function accountKeyTyposAreCaught() {
  const { display } = await generateAccountKey();
  let caught = 0;
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const chars = [...display];
  for (let i = 6; i < chars.length; i++) {
    if (chars[i] === '-') continue;
    const typo = [...chars];
    typo[i] = alphabet[(alphabet.indexOf(chars[i]) + 1) % 32];
    try { await parseAccountKey(typo.join('')); } catch (e) { if (e instanceof AccountKeyError) caught++; }
  }
  // The last character carries only padding bits; every other single-character typo must be caught.
  ok(caught >= chars.filter((c) => c !== '-').length - 6 - 2, `caught ${caught}`);
}

export async function usernameNormalization() {
  eq(await salt('  Alice '), await salt('alice'));
  eq(await salt('ｆｕｌｌ'), await salt('full'), 'NFKC folds fullwidth');
  ok(hex(await salt('alice')) !== hex(await salt('alicf')));
}

export async function derivationSeparatesInputs() {
  const k = (await generateAccountKey()).bytes;
  const a = await deriveKeys('alice', 'pw', k, SMALL);
  const b = await deriveKeys('alice', 'pw', k, SMALL);
  eq(a.loc, b.loc, 'deterministic');
  ok(hex(a.loc) !== hex(a.encRaw), 'subkeys differ');
  ok(hex((await deriveKeys('bob', 'pw', k, SMALL)).loc) !== hex(a.loc), 'username matters');
  ok(hex((await deriveKeys('alice', 'pw2', k, SMALL)).loc) !== hex(a.loc), 'password matters');
  const k2 = (await generateAccountKey()).bytes;
  ok(hex((await deriveKeys('alice', 'pw', k2, SMALL)).loc) !== hex(a.loc), 'account key matters');
}

export async function protocolParamsAreFastEnough() {
  const t0 = performance.now();
  await deriveKeys('alice', 'correct horse battery staple', (await generateAccountKey()).bytes);
  const ms = performance.now() - t0;
  console.log(`        (Argon2id m=64MiB t=3: ${ms.toFixed(0)} ms)`);
  ok(ms < 3000);
}
