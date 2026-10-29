import { handle, expire } from '../worker/src/handler.js';
import { validate, chiSquare } from '../worker/src/validate.js';
import { solve } from '../core/pow.js';
import { tag } from '../core/tag.js';
import { locate } from '../core/block.js';
import { b64, utf8 } from '../core/encoding.js';
import { random } from '../core/crypto.js';
import { buildHandleRecord, createIdentity, handlePath } from '../core/share.js';
import { testEnv, deps } from './helpers.js';
import { eq, ok } from '../tools/check.js';

const API = 'https://api.test/v1/';
const hourNow = () => Math.floor(Date.now() / 3600000);

async function send(env, method, path, body, { bits = 8, headers = {} } = {}) {
  const h = {
    'RSPM-PoW': await solve({ method, path, body, bits }),
    'RSPM-Tag': await tag(),
    ...headers,
  };
  return handle(new Request(API + path, { method, body, headers: h }), env, deps);
}

const block = () => { const b = random(4096); b[0] = 1; return b; };

async function freshPath() {
  const l = await locate(random(32), utf8('x'));
  return { path: `b/${l.id}`, token: l.token };
}

export async function createOnceAndDelete() {
  const env = testEnv();
  const { path, token } = await freshPath();
  const body = block();
  eq((await send(env, 'PUT', path, body)).status, 201);
  eq((await send(env, 'PUT', path, block())).status, 409, 'create-once');
  eq((await handle(new Request(API + path), env, deps)).status, 200);
  eq((await send(env, 'DELETE', path, random(32))).status, 403, 'wrong token');
  eq((await send(env, 'DELETE', path, token)).status, 204);
  eq((await send(env, 'DELETE', path, token)).status, 404);
}

export async function rejectsObviousNonCiphertext() {
  const env = testEnv();
  const cases = {
    zeros: () => { const b = new Uint8Array(4096); b[0] = 1; return b; },
    text: () => { const b = utf8('\x01' + 'my free storage '.repeat(300)).slice(0, 4096); return b; },
    base64: () => { const b = utf8('\x01' + b64(random(3100))).slice(0, 4096); return b; },
    hex: () => utf8('\x01' + Array.from(random(2048), (x) => x.toString(16).padStart(2, '0')).join('')).slice(0, 4096),
    wrongVersion: () => { const b = random(4096); b[0] = 2; return b; },
    short: () => { const b = random(4095); b[0] = 1; return b; },
  };
  for (const [name, make] of Object.entries(cases)) {
    const res = await send(env, 'PUT', (await freshPath()).path, make());
    eq(res.status, 400, name);
  }
  eq(env.BUCKET.objects.size, 0);
}

export async function honestBlocksAlwaysPass() {
  for (let i = 0; i < 3000; i++) {
    const reason = await validate('b/aaaaaaaaaaaaaaaaaaaaaaaaaa', block(), hourNow());
    if (reason) throw new Error(`random block ${i} rejected: ${reason}`);
  }
}

export function chiSquareSanity() {
  ok(chiSquare(random(4095)) < 400);
  ok(chiSquare(new Uint8Array(4095)) > 1e5);
}

export async function powAndTagRequired() {
  const env = testEnv({ POW_BITS: '12' });
  const { path } = await freshPath();
  eq((await send(env, 'PUT', path, block(), { bits: 0 })).status, 403, 'weak pow');
  eq((await send(env, 'PUT', path, block(), { bits: 12, headers: { 'RSPM-Tag': 'deadbeef' } })).status, 403, 'bad tag');
  const body = block();
  const pow = await solve({ method: 'PUT', path, body, bits: 12 });
  const other = (await freshPath()).path;
  const replay = await handle(new Request(API + other, { method: 'PUT', body, headers: { 'RSPM-PoW': pow, 'RSPM-Tag': await tag() } }), env, deps);
  eq(replay.status, 403, 'pow bound to path');
  eq((await send(env, 'PUT', path, body, { bits: 12 })).status, 201);
}

export async function expiringPathsAndCron() {
  const env = testEnv();
  const mk = async (h) => `e/${h}/${(await freshPath()).path.slice(2)}`;
  eq((await send(env, 'PUT', await mk(hourNow()), block())).status, 400, 'must be in the future');
  eq((await send(env, 'PUT', await mk(hourNow() + 721), block())).status, 400, 'max 30 days');
  const p = await mk(hourNow() + 1);
  eq((await send(env, 'PUT', p, block())).status, 201);
  eq(await expire(env, Date.now()), 0, 'not yet expired');
  eq(await expire(env, Date.now() + 2 * 3600000), 1);
  eq(env.BUCKET.objects.size, 0);
}

export async function handleRecords() {
  const env = testEnv();
  const id = await createIdentity('carson');
  const rec = await buildHandleRecord(id);
  eq((await send(env, 'PUT', await handlePath('someoneelse'), rec)).status, 400, 'record must match path');
  eq((await send(env, 'PUT', await handlePath('carson'), rec)).status, 201);
}

export async function corsOnlyForAppOrigin() {
  const env = testEnv();
  const ok1 = await handle(new Request('https://api.test/v1/pow', { headers: { Origin: 'https://rspm.me' } }), env, deps);
  eq(ok1.headers.get('Access-Control-Allow-Origin'), 'https://rspm.me');
  const evil = await handle(new Request('https://api.test/v1/pow', { headers: { Origin: 'https://evil.example' } }), env, deps);
  eq(evil.headers.get('Access-Control-Allow-Origin'), null);
  eq((await evil.json()).d, 8);
  const pre = await handle(new Request('https://api.test/v1/b/x', { method: 'OPTIONS', headers: { Origin: 'https://rspm.me' } }), env, deps);
  eq(pre.status, 204);
}

export async function badRequests() {
  const env = testEnv();
  eq((await handle(new Request(API + 'b/short'), env, deps)).status, 400);
  eq((await handle(new Request(API + 'x/aaaaaaaaaaaaaaaaaaaaaaaaaa'), env, deps)).status, 400);
  eq((await handle(new Request('https://api.test/elsewhere'), env, deps)).status, 404);
  eq((await send(env, 'PUT', (await freshPath()).path, random(5000))).status, 413);
}
