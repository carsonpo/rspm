// Minimal IndexedDB key-value store for per-device data (PROTOCOL §10).
// Failures (private mode, blocked storage) degrade to "nothing remembered".

const DB = 'rspm', STORE = 'kv';
let dbp;

function db() {
  dbp ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}

async function tx(mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    t.oncomplete = () => resolve(req?.result);
    t.onerror = () => reject(t.error);
  });
}

export async function get(key) {
  try { return await tx('readonly', (s) => s.get(key)); } catch { return undefined; }
}

export async function set(key, value) {
  try { await tx('readwrite', (s) => s.put(value, key)); } catch { /* storage unavailable */ }
}

export async function del(key) {
  try { await tx('readwrite', (s) => s.delete(key)); } catch { /* storage unavailable */ }
}
