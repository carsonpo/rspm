// Deterministic build. Zero dependencies. Everything it writes is committed,
// and `node tools/test.js` fails if the committed output is stale.
//
//   wasm/*.wat  → wasm/*.wasm
//   app/src/    → dist/rspm.me/                          (index.html + PWA files)
//   site/       → dist/reallysimplepasswordmanager.com/  (index.html)
//
// Usage: node tools/build.js [wasm|app|site]

import { buildWasm } from './lib.js';
import { buildApp } from './build-app.js';
import { buildSite } from './build-site.js';

const what = process.argv[2];
if (!what || what === 'wasm') {
  for (const [n, b] of Object.entries(buildWasm())) console.log(`wasm/${n}.wasm  ${b.length} bytes`);
}
if (!what || what === 'app') {
  const { hash, size } = await buildApp();
  console.log(`dist/rspm.me/index.html  ${(size / 1024).toFixed(0)} KiB\nsha256 ${hash}`);
}
if (!what || what === 'site') {
  const { size } = buildSite();
  console.log(`dist/reallysimplepasswordmanager.com/index.html  ${(size / 1024).toFixed(0)} KiB`);
}
