# worker

The Cloudflare Worker for `api.rspm.me`. It deliberately does very little:

- `PUT /v1/{path}`: verify the PoW and client tag, run the block validity checks
  (PROTOCOL §9.4, all in [src/validate.js](src/validate.js)), then do an atomic
  create-once write to R2.
- `DELETE /v1/{path}`: check the delete token, then delete.
- `GET /v1/pow`: report the current difficulty.
- `GET`/`HEAD /v1/{path}`: read fallback for self-hosted instances without a
  public bucket domain.
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

1. **R2 bucket `rspm-blocks`**: connect the custom domain `blocks.rspm.me` for
   public reads. Leave the `r2.dev` URL and listing disabled.
2. **Bucket CORS**: allow `GET` and `HEAD` from `https://rspm.me`.
3. **Cache rule** for `blocks.rspm.me`: don't cache `404` responses. Clients
   also send cache-busting queries on `HEAD`, but generation discovery must
   never see stale "not found" answers.
4. **`rspm.link`**: a redirect rule `301 → https://rspm.me/`. Browsers keep the
   `#fragment` across the redirect, and it never reaches either server.
5. **`rspm.me`**: serve `dist/rspm.me/` as static assets (committed; no build step).
   **reallysimplepasswordmanager.com**: serve `dist/reallysimplepasswordmanager.com/`. `_headers` sets
   `frame-ancestors 'none'` and the other headers that can't go in a `<meta>`.

> **Verify before launch:** the create-once write uses
> `put(key, body, { onlyIf: new Headers({ 'If-None-Match': '*' }) })`. The tests
> cover these semantics against an in-memory bucket. Confirm against real R2
> that a second `put` to the same key returns `null` and doesn't overwrite;
> multi-device safety (PROTOCOL §6.3) depends on it.

Self-hosting is the same steps with your own names. Set `APP_ORIGINS` to your
app's origin and build the app with `RSPM_API`/`RSPM_BLOCKS` pointing at your
instance.
