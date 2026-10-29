# rspm: really simple password manager

A password manager whose encrypted storage is a **public** bucket, intentionally.
If the bucket leaks, nothing happens, because it was already public.

- **Zero dependencies.** Only web standards (WebCrypto, `fetch`, `CompressionStream`,
  WebAssembly), plus a handful of primitives we implement ourselves and test against
  official vectors.
- **No recovery.** Username + password + a generated 128-bit Account Key. Lose
  them and the data is gone. That's the point.
- **Untrusted server.** Every object is a fixed 4096-byte block with an unlinkable
  name. The server can't read anything or tell which blocks belong together.
- **Post-quantum.** The vault is symmetric-only (AES-256). Sharing uses hybrid
  X25519 + ML-KEM-768.
- **One file.** The app is a single deterministic HTML file. Hash it, save it,
  self-host it.
- **Passkeys.** Touch ID, Face ID, Windows Hello or a YubiKey can protect the
  Account Key a device remembers (WebAuthn PRF).

Status: **pre-release.** The protocol, worker, web app, CLI and landing page are implemented and tested. The project has not been audited yet.

- [Protocol spec](docs/PROTOCOL.md)
- [Threat model](docs/THREAT_MODEL.md)

## Layout

```
app/       The web app and PWA served at rspm.me (plain ES modules in src/).
core/      Protocol implementation shared by app, CLI and worker: KDF, blocks, vault generations, shares, ML-KEM, SHA3, TOTP.
worker/    Cloudflare Worker: create-once PUT, token DELETE, PoW and block-validity checks, expiry cron.
cli/       Single-file CLI for Node, Bun and Deno: `rspm run --env <item> -- cmd`, TOTP, get.
wasm/      Hand-written WebAssembly text: Argon2id/BLAKE2b, the SHA-256 PoW search, the client tag.
site/      Landing page for reallysimplepasswordmanager.com.
dist/      Committed build output that Cloudflare serves: rspm.me/ and reallysimplepasswordmanager.com/.
tools/     Zero-dependency build, WAT assembler, test runner, dev server, icon renderer, browser driver.
test/      Tests, known-answer vectors, and the Go generator for differential vectors.
docs/      PROTOCOL.md, THREAT_MODEL.md.
```

## Domains

| Domain | Purpose |
|---|---|
| `rspm.me` | the app (PWA) |
| `api.rspm.me` | the worker |
| `rspm.link` | share links. A 301 redirect to `https://rspm.me/` (browsers keep the `#fragment`, so nothing secret reaches either server) |
| `reallysimplepasswordmanager.com` | landing page and docs |

## Commands

```sh
node tools/test.js      # vectors, protocol, worker, CLI, and that dist/ is current (Bun works too)
node tools/dev.js       # app + worker on http://localhost:4747, bucket stored in .dev-bucket/
node tools/build.js     # → wasm/*.wasm and dist/ (deterministic; commit the result)
node tools/e2e.js       # end-to-end in headless Chrome, including passkeys
node tools/icon.js      # re-render the app icons
node tools/gen-vectors.js                   # regenerate test/vectors/rspm.json
cd test/gen && GOTOOLCHAIN=go1.26.0 go run .  # regenerate differential vectors (dev only)
```

`package.json` exists only to set `"type": "module"` and provide script aliases.
It has no `dependencies` and never will.

## Self-hosting

Everything RSPM runs on is in this repo: one static HTML file, one worker, one
bucket. It fits within Cloudflare's free tier. See [worker/README.md](worker/README.md).
