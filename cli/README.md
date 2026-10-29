# cli

`rspm.js`: one file that runs on Node ≥ 20, Deno, or Bun using their built-in
WebCrypto. It imports from `core/`.

```sh
rspm run --env my-api -- npm start   # inject an env item's vars into a command
rspm totp github                     # print the current code
rspm get github --field password
```

Bun 1.2's WebCrypto has no X25519, so recipient (handle) shares can't be
created or opened under Bun. The CLI doesn't use them; everything else works.
