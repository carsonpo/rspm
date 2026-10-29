// Request handling for the rspm worker (PROTOCOL §9). Platform-independent:
// index.js binds it to Cloudflare; tests drive it with an in-memory bucket.
//
// Deliberately logs nothing.

import { equal } from '../../core/encoding.js';
import { sha256 } from '../../core/crypto.js';
import { verify as verifyPow } from '../../core/powcheck.js';
import { locatorFromToken } from '../../core/block.js';
import { validate, parsePath, BLOCK } from './validate.js';

const DEFAULT_BITS = 18;

/**
 * @param env  { BUCKET, POW_BITS?, APP_ORIGINS?, RATE_LIMITER? }
 * @param deps { verifyTag(header, nowSeconds) → Promise<boolean> }
 */
export async function handle(request, env, deps) {
  const url = new URL(request.url);
  const origin = request.headers.get('Origin');
  const cors = corsHeaders(origin, env);

  try {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    const res = await route(request, url, env, deps);
    for (const [k, v] of Object.entries(cors)) res.headers.set(k, v);
    return res;
  } catch {
    return new Response('internal error', { status: 500, headers: cors });
  }
}

function corsHeaders(origin, env) {
  const allowed = (env.APP_ORIGINS ?? 'https://rspm.me').split(',').map((s) => s.trim());
  if (!origin || !allowed.includes(origin)) return { Vary: 'Origin' };
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, HEAD, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, RSPM-PoW, RSPM-Tag',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

const text = (body, status) => new Response(body, { status, headers: { 'Content-Type': 'text/plain' } });

async function route(request, url, env, deps) {
  const now = Math.floor(Date.now() / 1000);
  const bits = Number(env.POW_BITS ?? DEFAULT_BITS);

  if (url.pathname === '/v1/pow' && request.method === 'GET') {
    return Response.json({ d: bits, now }, { headers: { 'Cache-Control': 'no-store' } });
  }

  if (!url.pathname.startsWith('/v1/')) return text('not found', 404);
  const path = url.pathname.slice(4);
  const parsed = parsePath(path);
  if (!parsed) return text('invalid path', 400);

  // Reads normally go straight to the public bucket; this fallback lets a
  // self-hosted instance run without a public bucket domain.
  if (request.method === 'GET' || request.method === 'HEAD') {
    const obj = request.method === 'GET' ? await env.BUCKET.get(path) : await env.BUCKET.head(path);
    if (!obj) return text('not found', 404);
    const body = request.method === 'GET' ? await obj.arrayBuffer() : null;
    return new Response(body, { status: 200, headers: { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store' } });
  }

  if (request.method !== 'PUT' && request.method !== 'DELETE') return text('method not allowed', 405);

  if (env.RATE_LIMITER) {
    const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown';
    const { success } = await env.RATE_LIMITER.limit({ key: ip });
    if (!success) return text('rate limited', 429);
  }

  const declared = Number(request.headers.get('Content-Length') ?? 0);
  if (declared > BLOCK) return text('too large', 413);
  const body = new Uint8Array(await request.arrayBuffer());
  if (body.length > BLOCK) return text('too large', 413);

  if (!(await deps.verifyTag(request.headers.get('RSPM-Tag'), now))) return text('bad tag', 403);
  if (!(await verifyPow(request.headers.get('RSPM-PoW'), { method: request.method, path, body, bits, now }))) {
    return text('bad pow', 403);
  }

  if (request.method === 'PUT') {
    const reason = await validate(path, body, Math.floor(now / 3600));
    if (reason) return text(reason, 400);
    // Atomic create-once: the write only happens if no object exists at `path`.
    const put = await env.BUCKET.put(path, body, { onlyIf: new Headers({ 'If-None-Match': '*' }) });
    return put ? text('created', 201) : text('exists', 409);
  }

  // DELETE: body is the 32-byte token.
  if (body.length !== 32) return text('token must be 32 bytes', 400);
  if (parsed.prefix === 'h') {
    const obj = await env.BUCKET.get(path);
    if (!obj) return text('not found', 404);
    const rec = new Uint8Array(await obj.arrayBuffer());
    if (!equal(await sha256(body), rec.subarray(1223, 1255))) return text('bad token', 403);
  } else {
    const { id } = await locatorFromToken(body);
    if (path.slice(-26) !== id) return text('bad token', 403);
    if (!(await env.BUCKET.head(path))) return text('not found', 404);
  }
  await env.BUCKET.delete(path);
  return new Response(null, { status: 204 });
}

/** Hourly cron: delete every e/{hour}/ prefix whose hour has passed (PROTOCOL §9.5). */
export async function expire(env, nowMs = Date.now()) {
  const hourNow = Math.floor(nowMs / 3600000);
  let deleted = 0;
  let cursor;
  const hours = [];
  do {
    const page = await env.BUCKET.list({ prefix: 'e/', delimiter: '/', cursor });
    for (const p of page.delimitedPrefixes) {
      const h = Number(p.slice(2, -1));
      if (h <= hourNow) hours.push(p);
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  for (const prefix of hours) {
    let c;
    do {
      const page = await env.BUCKET.list({ prefix, cursor: c, limit: 1000 });
      const keys = page.objects.map((o) => o.key);
      if (keys.length) { await env.BUCKET.delete(keys); deleted += keys.length; }
      c = page.truncated ? page.cursor : undefined;
    } while (c);
  }
  return deleted;
}

