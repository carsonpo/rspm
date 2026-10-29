import { wasmSha256, solve, verify, leadingZeroBits, pad } from '../core/pow.js';
import { tag, verifyTag } from '../core/tag.js';
import { sha256, random } from '../core/crypto.js';
import { eq, ok } from '../tools/check.js';

export async function wasmSha256MatchesWebCrypto() {
  // every length across several block boundaries, plus FIPS 180-4 "abc"
  for (let n = 0; n <= 300; n++) {
    const msg = random(n);
    eq(await wasmSha256(msg), await sha256(msg), `length ${n}`);
  }
  eq(await wasmSha256(new TextEncoder().encode('abc')),
    await sha256('abc'));
}

export function padding() {
  eq(pad(new Uint8Array(55)).length, 64);
  eq(pad(new Uint8Array(56)).length, 128);
}

export function zeroBits() {
  eq(leadingZeroBits(new Uint8Array([0, 0, 0x10, 0xff])), 19);
  eq(leadingZeroBits(new Uint8Array([0x80])), 0);
  eq(leadingZeroBits(new Uint8Array(4)), 32);
}

export async function solveAndVerify() {
  const body = random(4096);
  const req = { method: 'PUT', path: 'b/aaaaaaaaaaaaaaaaaaaaaaaaaa', body, bits: 16 };
  const header = await solve(req);
  ok(await verify(header, req), 'valid PoW verifies');
  ok(!(await verify(header, { ...req, path: 'b/bbbbbbbbbbbbbbbbbbbbbbbbbb' })), 'bound to path');
  ok(!(await verify(header, { ...req, method: 'DELETE' })), 'bound to method');
  ok(!(await verify(header, { ...req, body: random(4096) })), 'bound to body');
  ok(!(await verify(header, { ...req, now: Math.floor(Date.now() / 1000) + 400 })), 'expires');
  ok(!(await verify('garbage', req)), 'rejects malformed');
  ok(!(await verify(undefined, req)), 'rejects missing');
}

export async function powThroughput() {
  const t0 = performance.now();
  const req = { method: 'PUT', path: 'b/aaaaaaaaaaaaaaaaaaaaaaaaaa', body: new Uint8Array(4096), bits: 18 };
  for (let i = 0; i < 4; i++) await solve(req);
  const ms = (performance.now() - t0) / 4;
  console.log(`        (d=18 average ${ms.toFixed(0)} ms)`);
  ok(ms < 2000, 'd=18 solves in under 2 s on average');
}

export async function tagWindows() {
  const now = 1_800_000_000;
  const t = await tag(now);
  ok(/^[0-9a-f]{8}$/.test(t));
  ok(await verifyTag(t, now));
  ok(await verifyTag(t, now + 30), 'previous window accepted');
  ok(!(await verifyTag(t, now + 90)), 'old window rejected');
  ok((await tag(now)) !== (await tag(now + 30)), 'changes per window');
}

export async function concurrentSolvesDoNotInterfere() {
  // Regression: solves yield between chunks and share one wasm instance.
  const reqs = Array.from({ length: 6 }, (_, i) => ({ method: 'PUT', path: `b/${'abcdef'[i].repeat(26)}`, body: random(4096), bits: 17 }));
  const headers = await Promise.all(reqs.map((r) => solve(r)));
  for (let i = 0; i < reqs.length; i++) ok(await verify(headers[i], reqs[i]), `solve ${i}`);
}
