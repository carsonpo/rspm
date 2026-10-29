import { readFileSync } from 'node:fs';
import { argon2id, blake2b } from '../core/argon2.js';
import { hex, unhex, utf8 } from '../core/encoding.js';
import { eq, ok } from '../tools/check.js';

const vectors = (name) => JSON.parse(readFileSync(new URL(`vectors/${name}.json`, import.meta.url), 'utf8'));

// RFC 7693 Appendix A.
export async function blake2bRfc7693Abc() {
  eq(hex(await blake2b(utf8('abc'))),
    'ba80a53f981c4d0d6a2797b69f12f6e94c212f14685ac4b74b12bb6fdbffa2d1' +
    '7d87c5392aab792dc252d5de4533cc9518d38aa8dbf1925ab92386edd4009923');
}

// RFC 9106 §5.3, the only vector here that exercises secret and associated data.
export async function argon2idRfc9106() {
  const tag = await argon2id(new Uint8Array(32).fill(1), new Uint8Array(16).fill(2), {
    m: 32, t: 3, p: 4, len: 32, secret: new Uint8Array(8).fill(3), ad: new Uint8Array(12).fill(4),
  });
  eq(hex(tag), '0d640df58d78766c08c037a34a8b53c9d01ef0452d75b65eb52520e96b01e659');
}

export async function blake2bMatchesXCrypto() {
  const vs = vectors('blake2b');
  ok(vs.length > 300, 'vector file looks truncated');
  for (const v of vs) {
    const got = hex(await blake2b(unhex(v.input), v.outLen, unhex(v.key)));
    eq(got, v.hash, `blake2b(len=${v.input.length / 2}, key=${v.key.length / 2}, out=${v.outLen})`);
  }
}

export async function argon2idMatchesXCrypto() {
  const vs = vectors('argon2id');
  ok(vs.length > 300, 'vector file looks truncated');
  for (const v of vs) {
    const got = hex(await argon2id(unhex(v.password), unhex(v.salt), { m: v.m, t: v.t, p: v.p, len: v.len }));
    eq(got, v.tag, `argon2id(m=${v.m}, t=${v.t}, p=${v.p}, len=${v.len}${v.note ? `; ${v.note}` : ''})`);
  }
}

export async function argon2idRejectsBadParameters() {
  const pw = utf8('pw'), salt = new Uint8Array(16);
  const rejects = async (opts, re) => {
    try { await argon2id(pw, opts.salt ?? salt, { m: 64, t: 1, p: 1, len: 32, ...opts }); }
    catch (e) { ok(re.test(e.message), `"${e.message}" should match ${re}`); return; }
    throw new Error(`accepted ${JSON.stringify(opts)}`);
  };
  await rejects({ m: 15, p: 2 }, /m must be/);
  await rejects({ t: 0 }, /t must be/);
  await rejects({ len: 3 }, /len must be/);
  await rejects({ p: 0 }, /p must be/);
  await rejects({ salt: new Uint8Array(7) }, /salt must be at least 8/);
}
