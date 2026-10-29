import { readFileSync } from 'node:fs';
import { sha3_256, sha3_512, shake128, shake256, Keccak } from '../core/sha3.js';
import { hex, unhex, utf8 } from '../core/encoding.js';
import { eq, throws } from '../tools/check.js';

const vectors = JSON.parse(readFileSync(new URL('./vectors/sha3.json', import.meta.url)));
const msg = unhex(vectors.msg);

// FIPS 202 / NIST CSRC example values.
export function officialExamples() {
  eq(hex(sha3_256(new Uint8Array())), 'a7ffc6f8bf1ed76651c14756a061d662f580ff4de43b49fa82d80a4b80f8434a');
  eq(hex(sha3_256(utf8('abc'))), '3a985da74fe225b2045c172d6bd390bd855f086e3e9d525b46bfe24511431532');
  eq(hex(sha3_512(utf8('abc'))),
    'b751850b1a57168a5693cd924b6b096e08f621827444f70d884f5d0240d2712e10e116e9192af3c91a7ec57647e3934057340b4cf408d5a56592f8274eec53f0');
  eq(hex(shake128(new Uint8Array(), 32)), '7f9c2ba4e88f827d616045507605853ed73b8093f6efbc88eb1a6eacfa66ef26');
  eq(hex(shake256(new Uint8Array(), 32)), '46b9dd2b0ba88d13233b3feb743eeb243fcd52ea62b81b82b50c27646ed5762f');
}

export function everyLengthAgainstGo() {
  for (const c of vectors.cases) {
    const m = msg.subarray(0, c.len);
    eq(hex(sha3_256(m)), c.sha3_256, `sha3_256 len ${c.len}`);
    eq(hex(sha3_512(m)), c.sha3_512, `sha3_512 len ${c.len}`);
    eq(hex(shake128(m, 32)), c.shake128_32, `shake128 len ${c.len}`);
    eq(hex(shake256(m, 64)), c.shake256_64, `shake256 len ${c.len}`);
  }
}

export function longShakeOutputsAgainstGo() {
  for (const c of vectors.shake) {
    const m = msg.subarray(0, c.len);
    eq(hex(shake128(m, c.out_len)), c.shake128, `shake128 ${c.len}/${c.out_len}`);
    eq(hex(shake256(m, c.out_len)), c.shake256, `shake256 ${c.len}/${c.out_len}`);
  }
}

export function incrementalMatchesOneShot() {
  const want = hex(shake128(msg, 1000));
  for (const split of [0, 1, 167, 168, 169, 399]) {
    const x = Keccak.shake128().update(msg.subarray(0, split)).update(msg.subarray(split));
    // Squeeze in uneven chunks across block boundaries.
    const parts = [x.read(3), x.read(165), x.read(1), x.read(500), x.read(331)];
    eq(parts.map(hex).join(''), want, `split ${split}`);
  }
  throws(() => { const x = Keccak.sha3_256(); x.read(32); x.update(msg); }, /update after read/);
}
