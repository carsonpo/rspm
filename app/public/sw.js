// rspm service worker: serves the installed app offline and holds updates
// until the user approves them (PROTOCOL/THREAT_MODEL "Verifying the app").
//
// Note the limit: the browser fetches this file itself, bypassing any worker,
// so a malicious server could replace it. Holding updates protects the honest
// case; it is not a guarantee against a compromised host.

const SHELL = 'rspm-shell-v1';
const PENDING = 'rspm-pending-v1';
const ASSETS = ['/', '/manifest.webmanifest', '/icon.svg', '/icon-192.png', '/icon-512.png'];

const hex = (buf) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
const hashOf = async (res) => hex(await crypto.subtle.digest('SHA-256', await res.clone().arrayBuffer()));

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const c = await caches.open(SHELL);
    if (!(await c.match('/'))) await c.addAll(ASSETS);
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin || e.request.method !== 'GET') return;
  if (e.request.mode === 'navigate' || url.pathname === '/' || url.pathname === '/index.html') {
    e.respondWith((async () => (await (await caches.open(SHELL)).match('/')) ?? fetch(e.request))());
    e.waitUntil(checkForUpdate());
    return;
  }
  if (ASSETS.includes(url.pathname)) e.respondWith((async () => (await caches.match(url.pathname)) ?? fetch(e.request))());
});

async function checkForUpdate() {
  let res;
  try { res = await fetch('/', { cache: 'no-store' }); } catch { return; }
  if (!res.ok) return;
  const current = await (await caches.open(SHELL)).match('/');
  const [next, now] = await Promise.all([hashOf(res), current ? hashOf(current) : null]);
  if (next === now) return;
  await (await caches.open(PENDING)).put('/', res);
  for (const c of await self.clients.matchAll()) c.postMessage({ type: 'update-available', hash: next });
}

self.addEventListener('message', (e) => {
  e.waitUntil((async () => {
    if (e.data?.type === 'get-hash') {
      const cur = await (await caches.open(SHELL)).match('/');
      if (cur) e.source.postMessage({ type: 'build-hash', hash: await hashOf(cur) });
    }
    if (e.data?.type === 'apply-update') {
      const pending = await (await caches.open(PENDING)).match('/');
      if (!pending) return;
      await (await caches.open(SHELL)).put('/', pending);
      await caches.delete(PENDING);
      for (const c of await self.clients.matchAll()) c.postMessage({ type: 'updated' });
    }
  })());
});
