// Local development: builds the app against a local worker and serves both.
// The build goes to .dev/ (never dist/), and the bucket lives in .dev-bucket/
// so vaults survive restarts. Zero dependencies.
//
// Usage: node tools/dev.js [port]   → http://localhost:4747

import { createServer } from 'node:http';
import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, readdirSync, statSync } from 'node:fs';
import { join, extname, dirname } from 'node:path';
import { root } from './lib.js';
import { buildApp } from './build-app.js';
import { pathToFileURL } from 'node:url';
import { handle, expire } from '../worker/src/handler.js';
import { verifyTag } from '../core/tag.js';
import { createHash } from 'node:crypto';

const etag = (v) => createHash('sha256').update(v).digest('hex').slice(0, 32);

/** R2-compatible bucket on the local filesystem. */
class FsBucket {
  constructor(dir) { this.dir = dir; mkdirSync(dir, { recursive: true }); }
  file(key) { return join(this.dir, key); }
  async put(key, value, { onlyIf } = {}) {
    const f = this.file(key);
    const create = onlyIf?.get?.('If-None-Match') === '*';
    if (create && existsSync(f)) return null;
    const ifMatch = onlyIf?.get?.('If-Match');
    if (ifMatch && (!existsSync(f) || etag(readFileSync(f)) !== ifMatch)) return null;
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, new Uint8Array(value), { flag: create ? 'wx' : 'w' });
    return { key };
  }
  async get(key) {
    const f = this.file(key);
    if (!existsSync(f)) return null;
    const b = readFileSync(f);
    return { key, etag: etag(b), arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.length) };
  }
  async head(key) { return existsSync(this.file(key)) ? { key } : null; }
  async delete(keys) { for (const k of [].concat(keys)) rmSync(this.file(k), { force: true }); }
  async list({ prefix = '', delimiter }) {
    const all = [];
    const walk = (d, rel) => { if (!existsSync(d)) return; for (const e of readdirSync(d)) { const p = join(d, e); const r = rel ? `${rel}/${e}` : e; if (statSync(p).isDirectory()) walk(p, r); else all.push(r); } };
    walk(this.dir, '');
    const keys = all.filter((k) => k.startsWith(prefix)).sort();
    if (delimiter) return { objects: [], delimitedPrefixes: [...new Set(keys.map((k) => k.slice(prefix.length)).filter((r) => r.includes(delimiter)).map((r) => prefix + r.slice(0, r.indexOf(delimiter) + 1)))], truncated: false };
    return { objects: keys.map((key) => ({ key })), delimitedPrefixes: [], truncated: false };
  }
}

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png' };

/** Starts the dev server. Returns { origin, close }. */
export async function startDev({ port = 4747, bucketDir = join(root, '.dev-bucket'), powBits = process.env.POW_BITS ?? '18', quiet = false } = {}) {
  const origin = `http://localhost:${port}`;
  const outDir = join(root, '.dev', String(port));
  const endpoints = { api: origin, blocks: `${origin}/v1`, link: origin };
  const env = { BUCKET: new FsBucket(bucketDir), POW_BITS: String(powBits), APP_ORIGINS: origin };
  const deps = { verifyTag };
  await buildApp({ endpoints, outDir });
  const timer = setInterval(() => expire(env).catch(() => {}), 60000);

  // Production's site-wide headers (Permissions-Policy and friends), so local runs get the same policy.
  const site = JSON.parse(readFileSync(join(root, 'app/public/vercel.json'), 'utf8')).headers.find((x) => x.source === '/(.*)');
  const siteHeaders = Object.fromEntries(site.headers.map(({ key, value }) => [key, value]));

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, origin);
    try {
      if (url.pathname.startsWith('/v1/')) {
        const chunks = [];
        for await (const c of req) chunks.push(c);
        const body = ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks);
        const r = await handle(new Request(url, { method: req.method, headers: req.headers, body }), env, deps);
        res.writeHead(r.status, Object.fromEntries(r.headers));
        res.end(Buffer.from(await r.arrayBuffer()));
        return;
      }
      // Rebuild on every page load so edits show up on refresh.
      if (url.pathname === '/' || url.pathname === '/index.html') await buildApp({ endpoints, outDir });
      const name = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      const file = join(outDir, name);
      if (name.includes('..') || name.includes('/') || !existsSync(file)) { res.writeHead(404).end('not found'); return; }
      res.writeHead(200, { ...siteHeaders, 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' });
      res.end(readFileSync(file));
    } catch (err) {
      if (!quiet) console.error(err);
      res.writeHead(500).end(String(err.message));
    }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, resolve); });
  return { origin, close: () => { clearInterval(timer); server.close(); rmSync(outDir, { recursive: true, force: true }); } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { origin } = await startDev({ port: Number(process.argv[2] ?? 4747) });
  console.log(`rspm dev → ${origin}`);
}
