# core

The reference implementation of [PROTOCOL.md](../docs/PROTOCOL.md). It is shared
by the app and the CLI and uses only WebCrypto, `fetch`, `CompressionStream`,
and WebAssembly.

Planned modules: `encoding.js` (b32, u32be/u64be), `kdf.js` (§3), `block.js` (§4),
`vault.js` (§5–7), `share.js` (§8), `mlkem.js` (FIPS 203 + SHA3), `api.js` (§9 client
side, PoW).
