// Builds dist/rspm.me/: the whole app as one self-contained index.html, plus
// the PWA shell files (manifest, service worker, icons, _headers).
//
// The bundler is deliberately small: it understands only the import/export
// forms this repo uses, and fails loudly on anything else. Each module becomes
// a function scope in dependency order, so there are no name collisions and
// no runtime loader. Output is deterministic: same sources → same bytes.
//
// The committed build always uses PRODUCTION; tools/dev.js builds a local
// variant into .dev/ so it can never overwrite it.

import { mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, relative, resolve } from 'node:path';
import { root, buildWasm } from './lib.js';

const sha256b64 = (s) => createHash('sha256').update(s).digest('base64');
const sha256hex = (s) => createHash('sha256').update(s).digest('hex');

const IMPORT = /^import\s+(?:\{([^}]*)\}|\*\s+as\s+(\w+))\s+from\s+'([^']+)';?\s*$/gm;
const EXPORT_DECL = /^export\s+(async\s+function\*?|function\*?|class|const|let)\s+(\w+)/gm;
const EXPORT_LIST = /^export\s+\{([^}]*)\};?\s*$/gm;

function bundle(entry) {
  const order = [];
  const seen = new Map();
  const visit = (file, stack = []) => {
    if (seen.has(file)) {
      if (stack.includes(file)) throw new Error(`circular import: ${[...stack, file].map((f) => relative(root, f)).join(' → ')}`);
      return;
    }
    seen.set(file, null);
    const src = readFileSync(file, 'utf8');
    const deps = [...src.matchAll(IMPORT)].map((m) => resolve(dirname(file), m[3]));
    for (const d of deps) visit(d, [...stack, file]);
    order.push(file);
  };
  visit(resolve(entry));

  const ids = new Map(order.map((f, i) => [f, `$m${i}`]));
  const chunks = order.map((file) => {
    let src = readFileSync(file, 'utf8');
    const exportsList = [];
    src = src.replace(IMPORT, (_, named, ns, spec) => {
      const id = ids.get(resolve(dirname(file), spec));
      if (ns) return `const ${ns} = ${id};`;
      const parts = named.split(',').map((s) => s.trim()).filter(Boolean)
        .map((s) => { const [a, b] = s.split(/\s+as\s+/); return b ? `${a}: ${b}` : a; });
      return `const { ${parts.join(', ')} } = ${id};`;
    });
    src = src.replace(EXPORT_DECL, (_, kind, name) => { exportsList.push(name); return `${kind} ${name}`; });
    src = src.replace(EXPORT_LIST, (_, names) => {
      for (const s of names.split(',').map((x) => x.trim()).filter(Boolean)) {
        const [a, b] = s.split(/\s+as\s+/);
        exportsList.push(b ? `${b}: ${a}` : a);
      }
      return '';
    });
    const leftover = /^\s*(import|export)\b(?!\s*\()/m.exec(src);
    if (leftover) throw new Error(`${relative(root, file)}: unsupported module syntax near "${src.slice(leftover.index, leftover.index + 60).trim()}"`);
    return `// ${relative(root, file)}\nconst ${ids.get(file)} = (() => {\n${src.trim()}\nreturn { ${exportsList.join(', ')} };\n})();`;
  });
  return { code: chunks.join('\n\n'), files: order };
}

export const PRODUCTION = Object.freeze({
  api: 'https://api.rspm.me',
  blocks: 'https://api.rspm.me/v1',
  link: 'https://rspm.link',
});

/** Writes `files` (name → bytes) into `dir`, replacing whatever was there. */
export function writeDir(dir, files) {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  for (const [name, bytes] of files) writeFileSync(join(dir, name), bytes);
}

/**
 * Returns { files: Map(name → Buffer), hash } for the app. Writes them to
 * `outDir` unless `write` is false.
 */
export async function buildApp({ endpoints = PRODUCTION, outDir = join(root, 'dist/rspm.me'), write = true } = {}) {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const config = { ...endpoints, version: pkg.version };
  const wasm = buildWasm({ write: false });
  const { code } = bundle(join(root, 'app/src/main.js'));

  const wasmB64 = Object.fromEntries(Object.entries(wasm).map(([k, v]) => [k, Buffer.from(v).toString('base64')]));
  const script = [
    `globalThis.RSPM_CONFIG = Object.freeze(${JSON.stringify(config)});`,
    `globalThis.RSPM_WASM = Object.freeze(${JSON.stringify(wasmB64)});`,
    code,
  ].join('\n');
  const style = readFileSync(join(root, 'app/src/styles.css'), 'utf8');

  const origins = [...new Set([config.api, config.blocks].map((u) => new URL(u).origin))];
  const csp = [
    "default-src 'none'",
    `script-src 'sha256-${sha256b64(script)}' 'wasm-unsafe-eval'`,
    `style-src 'sha256-${sha256b64(style)}'`,
    `connect-src ${origins.join(' ')}`,
    "img-src data: 'self'",
    "manifest-src 'self'",
    "worker-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "require-trusted-types-for 'script'",
    'trusted-types rspm-sw',
  ].join('; ');

  const template = readFileSync(join(root, 'app/src/index.html'), 'utf8');
  const html = template
    .replace('{{CSP}}', () => csp)
    .replace('{{STYLE}}', () => style)
    .replace('{{SCRIPT}}', () => script);
  for (const marker of ['{{CSP}}', '{{STYLE}}', '{{SCRIPT}}']) if (html.includes(marker)) throw new Error(`template marker ${marker} left over`);

  const files = new Map([['index.html', Buffer.from(html)]]);
  for (const f of readdirSync(join(root, 'app/public')).sort()) files.set(f, readFileSync(join(root, 'app/public', f)));
  if (write) writeDir(outDir, files);
  return { files, hash: sha256hex(html), size: html.length };
}
