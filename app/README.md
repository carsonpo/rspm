# app

The web app and PWA. Plain ES modules in `src/`. No framework: a small in-repo
reactive layer (`src/ui.js`) that **can only write `textContent`** and has no
`innerHTML` path, so a whole class of XSS bugs can't happen.

`node tools/build.js` produces `dist/rspm.me/index.html`: one self-contained file with all
JS, CSS, and WASM inlined, and a CSP `<meta>` that pins each inline script by its
SHA-256 hash (`script-src 'sha256-…' 'wasm-unsafe-eval'`). The build is
deterministic: no timestamps and a fixed module order. The release hash is the
SHA-256 of this file. The PWA shell (manifest, service worker, icons and
`_headers`) is copied next to it from `public/`. The build output is committed,
and `node tools/test.js` fails if it is stale.

The app works when served from `rspm.me`, from your own domain, or opened from
`file://`.

## Design

Aesthetics are a requirement, not polish. A password manager has to *feel*
trustworthy, and calm, legible interfaces lead to fewer mistakes. The UI should
be beautiful, legible, and clean:

- **Typography first.** A system font stack (no web fonts to load or trust), a
  strict type scale, generous line height, and tabular figures for codes and
  counters.
- **Quiet.** One accent color, plenty of whitespace, no ornament that doesn't
  carry meaning. Security warnings stand out because nothing else competes with them.
- **Legible everywhere.** WCAG AA contrast at minimum, light and dark themes via
  `prefers-color-scheme`, a layout that works at 320 px, and visible focus states.
- **Restrained motion.** Short, purposeful transitions, all disabled under
  `prefers-reduced-motion`.
- **Design tokens** (color, space, radius, type) defined once as CSS custom
  properties. Components never hard-code values.
