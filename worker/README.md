# worker

The Cloudflare Worker for `api.rspm.me`. It deliberately does very little:

- `PUT /v1/{path}`: verify the PoW and client tag, run the block validity checks
  (PROTOCOL §9.4, all in [src/validate.js](src/validate.js)), then do an atomic
  create-once write to R2.
- `DELETE /v1/{path}`: check the delete token, then delete.
- `GET /v1/pow`: report the current difficulty.
- `GET`/`HEAD /v1/{path}`: public reads. This is where clients read blocks from.
- An hourly cron job that deletes expired `e/{hour}/` prefixes.

No logging. No accounts. No plaintext ever arrives here. The worker is
untrusted by design, so its correctness affects availability but never
confidentiality.

[src/handler.js](src/handler.js) is platform-independent; the tests and
`tools/dev.js` drive it with an in-memory or on-disk bucket.
[src/index.js](src/index.js) binds it to Cloudflare.

## Deploying

```sh
node tools/build.js wasm      # the worker imports wasm/tag.wasm
npx wrangler deploy           # wrangler is a deploy tool, not a code dependency
```

Then, in the Cloudflare dashboard:

1. **R2 bucket `rspm-blocks`**, bound to the worker as `BUCKET`. Reads go
   through the worker, so the bucket needs no domain of its own. Leave listing off.
2. **Optional public bucket domain.** To serve reads straight from R2, connect a
   custom domain, allow `GET`/`HEAD` from `https://rspm.me` in the bucket's CORS
   policy, add a cache rule so `404`s aren't cached (generation discovery must
   never see a stale "not found"), and build with `blocks` pointing at that domain.
3. **`rspm.link`**: a redirect rule `301 → https://rspm.me/`. Browsers keep the
   `#fragment` across the redirect, and it never reaches either server.
4. **`rspm.me`**: serve `dist/rspm.me/` as static assets (committed; no build
   step). It carries the headers that can't go in a `<meta>` (`frame-ancestors
   'none'` and friends) in two formats: `vercel.json` for Vercel (set the
   project's Root Directory to `dist/rspm.me`) and `_headers` for Cloudflare Pages.
   Serve the app on the **apex** `rspm.me`; if `www` exists, redirect it to the
   apex. The worker's CORS (`APP_ORIGINS`), passkeys, and share links are all
   tied to that exact origin.
5. **reallysimplepasswordmanager.com**: serve `dist/reallysimplepasswordmanager.com/`.
6. **If a site is proxied through Cloudflare** (orange cloud, including in front
   of Vercel), turn off everything that rewrites HTML: Web Analytics
   automatic setup (it injects `beacon.min.js`), Rocket Loader, Email Address
   Obfuscation, and Auto Minify. Each one changes the served bytes. The CSP blocks
   injected scripts anyway, but the page would no longer match its published hash.
   Check with `curl -s https://rspm.me/ | shasum -a 256`, which must equal the
   hash `node tools/build.js` prints. The simplest fix in front of Vercel is to
   set those DNS records to DNS-only (grey cloud).

> **Verify before launch:** the create-once write uses
> `put(key, body, { onlyIf: new Headers({ 'If-None-Match': '*' }) })`. The tests
> cover these semantics against an in-memory bucket. Confirm against real R2
> that a second `put` to the same key returns `null` and doesn't overwrite;
> multi-device safety (PROTOCOL §6.3) depends on it.

Self-hosting is the same steps with your own names. Set `APP_ORIGINS` to your
app's origin and build the app with `RSPM_API`/`RSPM_BLOCKS` pointing at your
instance.
