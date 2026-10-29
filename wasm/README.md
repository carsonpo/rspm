# wasm

Hand-written WebAssembly text. No compilers and no wabt: `tools/wat.js` assembles
the small instruction subset these files use.

| File | Purpose | Security role |
|---|---|---|
| `argon2.wat` | Argon2id + BLAKE2b (RFC 9106) | **Critical.** Password KDF. |
| `pow.wat` | SHA-256 nonce search | Abuse cost. Verified server-side with WebCrypto. |
| `tag.wat` | Deliberately obscure time-window function | **None.** Nuisance filter only (PROTOCOL §9.3). |
