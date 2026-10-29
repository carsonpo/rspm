import { readFileSync } from 'node:fs';
import * as mlkem from '../core/mlkem.js';
import { sha3_256 } from '../core/sha3.js';
import { hex, unhex } from '../core/encoding.js';
import { eq, ok, throws } from '../tools/check.js';

const load = (f) => JSON.parse(readFileSync(new URL(`./vectors/${f}`, import.meta.url)));
const acvp = load('mlkem768-acvp.json');
const go = load('mlkem768.json');

// ── NIST ACVP (pinned ACVP-Server commit, see the file's "commit") ──────────

export function acvpKeyGen() {
  for (const t of acvp.keyGen) {
    const { ek, dk } = mlkem.keygen(unhex(t.d + t.z));
    eq(hex(ek), t.ek);
    eq(hex(dk), t.dk);
  }
}

export function acvpEncapsulation() {
  for (const t of acvp.encapsulation) {
    const { ct, ss } = mlkem.encaps(unhex(t.ek), unhex(t.m));
    eq(hex(ct), t.c);
    eq(hex(ss), t.k);
  }
}

export function acvpDecapsulation() {
  for (const t of acvp.decapsulation) eq(hex(mlkem.decaps(unhex(t.dk), unhex(t.c))), t.k, t.reason);
}

export function acvpKeyChecks() {
  for (const t of acvp.encapsulationKeyCheck) eq(mlkem.checkEncapsulationKey(unhex(t.ek)), t.testPassed, t.reason);
  for (const t of acvp.decapsulationKeyCheck) eq(mlkem.checkDecapsulationKey(unhex(t.dk)), t.testPassed, t.reason);
}

// ── Differential against Go crypto/mlkem ────────────────────────────────────

export function goKeygen() {
  for (const t of go.keygen) {
    const { ek } = mlkem.keygen(unhex(t.seed));
    eq(hex(sha3_256(ek)), t.ek_sha3_256, `seed ${t.seed}`);
    if (t.ek) eq(hex(ek), t.ek);
  }
}

export function goHonestAndTamperedDecaps() {
  for (const t of go.honest) {
    const { ek, dk } = mlkem.keygen(unhex(t.seed));
    const { ct, ss } = mlkem.encaps(ek, unhex(t.m));
    eq(hex(sha3_256(ct)), t.ct_sha3_256);
    eq(hex(ss), t.ss);
    eq(hex(mlkem.decaps(dk, ct)), t.ss);
    for (const { pos, xor, ss: rejected } of t.tampered) {
      const bad = ct.slice();
      bad[pos] ^= xor;
      eq(hex(mlkem.decaps(dk, bad)), rejected, `tampered ${pos}^${xor}`);
    }
  }
}

export function goRandomCiphertexts() {
  for (const t of go.random_ct) {
    const { dk } = mlkem.keygen(unhex(t.seed));
    eq(hex(mlkem.decaps(dk, unhex(t.ct))), t.ss);
  }
}

export function goRejectsOutOfRangeKeys() {
  for (const t of go.bad_ek) {
    const ek = mlkem.keygen(unhex(t.seed)).ek;
    const b = ek.subarray(3 * (t.coeff >> 1));
    if (t.coeff % 2 === 0) { b[0] = t.value & 0xff; b[1] = (b[1] & 0xf0) | (t.value >> 8); }
    else { b[1] = (b[1] & 0x0f) | ((t.value << 4) & 0xf0); b[2] = t.value >> 4; }
    eq(mlkem.checkEncapsulationKey(ek), false);
    throws(() => mlkem.encaps(ek), /invalid encapsulation key/);
  }
}

// ── API behaviour ───────────────────────────────────────────────────────────

export function randomRoundTrip() {
  for (let i = 0; i < 20; i++) {
    const { ek, dk } = mlkem.keygen(crypto.getRandomValues(new Uint8Array(64)));
    const { ct, ss } = mlkem.encaps(ek);
    eq(ct.length, mlkem.CT_BYTES);
    eq(hex(mlkem.decaps(dk, ct)), hex(ss));
  }
}

export function inputValidation() {
  const { ek, dk } = mlkem.keygen(new Uint8Array(64));
  eq([ek.length, dk.length], [1184, 2400]);
  throws(() => mlkem.keygen(new Uint8Array(32)), /seed must be 64 bytes/);
  throws(() => mlkem.encaps(ek.subarray(1)), /invalid encapsulation key/);
  throws(() => mlkem.encaps(ek, new Uint8Array(31)), /m must be 32 bytes/);
  throws(() => mlkem.decaps(dk, new Uint8Array(1087)), /1088 bytes/);
  const badDk = dk.slice();
  badDk[1500] ^= 1; // inside the embedded ek → hash check fails
  throws(() => mlkem.decaps(badDk, new Uint8Array(1088)), /invalid decapsulation key/);
  ok(mlkem.checkDecapsulationKey(dk));
}
