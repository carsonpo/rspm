// The build output is committed (Cloudflare serves it straight from the repo),
// so it must always match what the sources produce.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { root, buildWasm } from '../tools/lib.js';
import { buildApp } from '../tools/build-app.js';
import { buildSite } from '../tools/build-site.js';
import { eq, ok } from '../tools/check.js';

const STALE = 'is stale — run `node tools/build.js` and commit the result';

function sameDir(dir, files) {
  eq(readdirSync(dir).sort(), [...files.keys()].sort(), `${dir} file list ${STALE}`);
  for (const [name, bytes] of files) ok(readFileSync(join(dir, name)).equals(bytes), `${dir}/${name} ${STALE}`);
}

export function committedWasmIsCurrent() {
  for (const [name, bytes] of Object.entries(buildWasm({ write: false }))) {
    ok(readFileSync(join(root, 'wasm', `${name}.wasm`)).equals(Buffer.from(bytes)), `wasm/${name}.wasm ${STALE}`);
  }
}

export async function committedAppIsCurrent() {
  sameDir(join(root, 'dist/rspm.me'), (await buildApp({ write: false })).files);
}

export function committedSiteIsCurrent() {
  sameDir(join(root, 'dist/reallysimplepasswordmanager.com'), buildSite({ write: false }).files);
}
