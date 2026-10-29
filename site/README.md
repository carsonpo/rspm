# site

The landing page for **reallysimplepasswordmanager.com**. The app itself lives
at rspm.me (see `app/`).

Source: `index.html`, `site.css`, `site.js`, `icon.svg`. These open directly in a browser. `node tools/build.js site`
inlines them into the single committed file `dist/reallysimplepasswordmanager.com/index.html`,
which is what Cloudflare serves.
Same rules as the rest of the repo: no frameworks, no web fonts, and no markup
strings assigned from JS. The CSP allows only same-origin scripts and styles.

- **The bucket wall**: an animated view of a public bucket. Hover a tile to
  see its locator. Animation stops under `prefers-reduced-motion`.
- **The live demo**: encrypts whatever you type into a real 4096-byte rspm
  block (PROTOCOL §4.3) with a throwaway key, and draws the bytes before and
  after. Nothing leaves the page.

Preview locally: `cd site && python3 -m http.server`, or any static server.
