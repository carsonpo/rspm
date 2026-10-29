// Builds dist/reallysimplepasswordmanager.com/index.html: the landing page as
// one self-contained file. The source in site/ stays plain files you can open
// directly; this inlines the stylesheet, script and icon, and pins them in the
// CSP by hash.

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { root } from './lib.js';
import { writeDir } from './build-app.js';

const sha256b64 = (s) => createHash('sha256').update(s).digest('base64');

function replaceOnce(html, from, to) {
  if (!html.includes(from)) throw new Error(`site/index.html: expected to find ${from}`);
  return html.replace(from, () => to);
}

export function buildSite({ outDir = join(root, 'dist/reallysimplepasswordmanager.com'), write = true } = {}) {
  const read = (f) => readFileSync(join(root, 'site', f), 'utf8');
  const css = read('site.css');
  const js = read('site.js');
  const icon = `data:image/svg+xml;base64,${Buffer.from(read('icon.svg')).toString('base64')}`;
  const csp = `default-src 'none'; script-src 'sha256-${sha256b64(js)}'; style-src 'sha256-${sha256b64(css)}'; img-src data:; base-uri 'none'; form-action 'none'`;

  let html = read('index.html');
  html = html.replace(/<meta http-equiv="Content-Security-Policy" content="[^"]*">/, () => `<meta http-equiv="Content-Security-Policy" content="${csp}">`);
  html = replaceOnce(html, '<link rel="icon" href="icon.svg" type="image/svg+xml">', `<link rel="icon" href="${icon}" type="image/svg+xml">`);
  html = replaceOnce(html, '<link rel="stylesheet" href="site.css">', `<style>${css}</style>`);
  // An inline module script is deferred, like the `defer` script it replaces.
  html = replaceOnce(html, '<script src="site.js" defer></script>', `<script type="module">${js}</script>`);
  if (!html.includes(`script-src 'sha256-`)) throw new Error('site/index.html: CSP meta tag not found');

  const files = new Map([['index.html', Buffer.from(html)]]);
  if (write) writeDir(outDir, files);
  return { files, size: html.length };
}
