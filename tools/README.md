# tools

Zero-dependency developer tools, run with `node` (or `bun`):

- `build.js`: builds `wasm/*.wasm`, the app (`build-app.js` → `dist/rspm.me/`) and the
  landing page (`build-site.js` → `dist/reallysimplepasswordmanager.com/`). Deterministic, and
  the output is committed.
- `wat.js`: minimal WAT → WASM assembler for the subset used in `wasm/`.
- `test.js` / `check.js`: test runner and assertions. No framework.
- `dev.js`: local app + worker on http://localhost:4747. Builds into `.dev/`, bucket in `.dev-bucket/`.
- `e2e.js`: end-to-end test in headless Chrome, including passkeys via a virtual authenticator.
- `gen-vectors.js`: regenerates the RSPM known-answer vectors.
- `icon.js`: renders the app icons (SVG + PNG, with a tiny PNG encoder).
- `browser.js`: the Chrome DevTools Protocol driver `e2e.js` uses.
- `lib.js`: shared helpers (repo root, WASM build).
