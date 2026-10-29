// Test runner. Zero dependencies.
//
// Runs every test/**/*.test.js. A test file's exports are its tests: each
// exported (async) function is run by name.
//
// Usage: node tools/test.js [filter]

import { readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const filter = process.argv[2] ?? '';

function* walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (e.name.endsWith('.test.js')) yield p;
  }
}

let passed = 0, failed = 0;
for (const file of walk(join(root, 'test'))) {
  const mod = await import(pathToFileURL(file).href);
  for (const [name, fn] of Object.entries(mod)) {
    const label = `${relative(root, file)} › ${name}`;
    if (typeof fn !== 'function' || !label.includes(filter)) continue;
    try {
      await fn();
      passed++;
      console.log(`  ok    ${label}`);
    } catch (err) {
      failed++;
      console.log(`  FAIL  ${label}\n        ${err.message}`);
    }
  }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
