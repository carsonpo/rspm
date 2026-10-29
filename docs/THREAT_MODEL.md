# RSPM Threat Model (DRAFT)

This document describes what RSPM protects, who it protects against, and where
those protections stop. Byte-level details are in [PROTOCOL.md](PROTOCOL.md).
Where this document and the protocol disagree, the protocol wins, and the
disagreement is a bug.

## Summary

> Storage and the worker are untrusted. They see only fixed-size ciphertext and
> access metadata, and the client detects tampering and rollback. The one trusted
> component is the HTML you run. You can verify it against the repository by
> hash, or remove the hosted copy from your trust entirely by running the
> single-file build locally or on your own domain. Cloudflare can see access
> metadata for the hosted instance and, like any web host, could in principle
> alter the page it serves. If that's in your threat model, self-host.

## What we protect

| Asset | Protection |
|---|---|
| Vault contents (passwords, notes, TOTP seeds, env vars) | Confidentiality and integrity |
| Username | Confidentiality: never sent, never stored |
| Which objects belong to which vault, how many vaults exist, vault size | Hidden from bucket observers; partly visible to the operator (A3) |
| Share contents | Confidentiality; only the link holder (link share) or the handle owner (recipient share) can read them |

## Components and trust

| Component | Trusted? | Why |
|---|---|---|
| The app HTML (`index.html` at rspm.me) | **Yes** | It handles plaintext. It is the only component you have to trust, and you can verify it (see "Verifying the app" below). |
| Your device and browser | **Yes** | Out of scope (R1). |
| Worker (`api.rspm.me`) | No | It only creates and deletes opaque 4096-byte objects. Its source is public, but no security property relies on it behaving correctly. |
| Bucket (`blocks.rspm.me`) | No | Public by design. |
| Cloudflare | No for confidentiality; yes for availability, and yes for app integrity *if you use the hosted copy* | See A3 and A4. |
| Network | No | TLS is used, but everything is already encrypted end to end. |

## Adversaries

### A1. Anyone holding a full copy of the bucket
**Learns:** object counts per prefix, creation and deletion times, share expiry
hours, and public handles (PROTOCOL §11).
**Cannot:** link blocks to each other or to a user, tell how many vaults exist or
how large they are, or decrypt anything. Offline brute force has to guess
`(username, password, 128-bit Account Key)` together, with Argon2id on every
guess, so it is infeasible.

### A2. An attacker who has the Account Key (stolen Emergency Kit or device)
Security now rests on the password plus Argon2id (64 MiB, t=3). A strong
password still holds; a weak one won't. This is why the password and the
Emergency Kit must be stored separately.

A device that remembers the Account Key with **passkey protection**
(PROTOCOL §10.2) stores it encrypted under a secret held by the platform
authenticator or security key. Someone who copies the browser's storage gets
ciphertext. They also need the user's fingerprint, face, PIN or physical key,
and still the password. A key remembered *without* passkey protection can be
read by anyone with access to the browser profile.

### A3. Operator, or Cloudflare, watching the hosted instance
**Learns, in addition to A1:** the client IP and timing of each read and write,
and therefore which objects a client fetches together. From that it can infer
roughly one user's vault size class and when they save. Handle lookups reveal
who looks up whom.
**Cannot:** decrypt, forge, or reorder blocks, or learn usernames.
**Can:** deny service, delete objects, or roll a vault back to an older
generation. A device that has seen a newer generation detects the rollback
(PROTOCOL §6.4); a brand-new device does not (R6).

### A4. Whoever controls what `rspm.me` serves
This includes the maintainer, a compromised Cloudflare/GitHub/registrar
account, or a legal order. **They can steal everything** by serving modified
HTML. This is the hard limit of any web-delivered end-to-end encrypted app.
Mitigations:
- The build is deterministic: anyone can rebuild from a git tag and compare the hash.
- The app is a single self-contained file. Users can save it and run it locally
  or from their own domain, which removes the hosted copy from their trust entirely.
- The running build shows its own hash in the UI. The honest build does this to
  make tampering conspicuous; a malicious build could fake the display, so this
  is not proof.
- The maintainer's accounts use hardware security keys and require signed,
  reviewed commits for deploys.

### A5. A recipient or forwarder of a share link
A link share gives access to whoever has the link until it expires or is burned.
A recipient share is useless to anyone who doesn't hold the recipient's identity
keys. **Expiry deletes the ciphertext; it cannot make a recipient forget what
they already decrypted.** Treat any secret you've shared as exposed, and rotate
it if that matters.

### A6. Quantum adversary (harvest now, decrypt later)
Vault encryption is purely symmetric with 256-bit keys, which remains safe.
Recipient shares use a hybrid of X25519 and ML-KEM-768, so breaking one requires
breaking both. TLS is irrelevant to confidentiality because the payloads are
already encrypted end to end.

### A7. Abusers using the bucket as free storage, or spamming it
The worker rejects non-ciphertext-looking blocks (PROTOCOL §9.4). Every write
requires a proof-of-work and is rate-limited per IP. Encrypted junk still gets
through, at a CPU cost per 4 KiB. The client tag (§9.3) is a nuisance filter,
**not** a security control.

## Guarantees

- **G1.** Without all three of username, password, and Account Key, no party can
  decrypt or locate a vault, given AES-256, SHA-256, and Argon2id.
- **G2.** Any modification, substitution, or reordering of blocks is detected.
- **G3.** Every stored object is 4096 bytes and starts with `0x01`; vault blocks
  and share blocks look random.
- **G4.** Concurrent saves from several devices never corrupt the vault (atomic
  create-once heads, PROTOCOL §6.3).
- **G5.** Vault confidentiality survives a cryptographically relevant quantum
  computer.

## Non-goals and residual risks

- **R1. Compromised device or browser.** Malware, malicious extensions, or a
  compromised OS see everything you unlock.
- **R2. Malicious app delivery** (A4) for users who don't verify or self-host.
- **R3. Access-pattern metadata seen by the operator** (A3). Size classes and
  padding blur it; nothing short of ORAM eliminates it.
- **R4. Deletion is best-effort.** Old ciphertext that someone downloaded before
  a password change or deletion stays decryptable with the old credentials.
  This is why changing credentials creates a fresh vault (PROTOCOL §7).
- **R5. No recovery.** If you lose your username, password, or Account Key, the
  data is gone. This is intentional. Nobody, including the maintainers, can help.
- **R6. A fresh device cannot detect rollback** and may be shown an older
  generation.
- **R7. Handle substitution.** The server can substitute a handle's public keys
  unless fingerprints are checked out of band.
- **R8. Denial of service and data deletion by the operator.** Mitigation: the
  app offers an encrypted export to a local file.
- **R9. Phishing.** There is no browser-extension autofill (yet), so users
  copy and paste credentials and the app can't check which domain they're on.
- **R10. TOTP seeds in the same vault** combine both factors behind one secret.
  This is the user's choice, and the app warns about it.
- **R11. Implementation bugs.** "Zero dependencies" removes supply-chain risk but
  means Argon2id, BLAKE2b, ML-KEM, SHA3, and the PoW loop are our own,
  unaudited code. Constant-time behaviour in JS/WASM is best-effort. Each is
  tested against official vectors and differentially against a pinned
  reference implementation (Go's `crypto/mlkem`, `crypto/sha3`,
  `x/crypto/argon2`). An external audit is planned before 1.0.

## User responsibilities

1. Store the Emergency Kit (Account Key) somewhere separate from your password.
2. Choose a password you won't forget. It can't be reset.
3. For high assurance, verify the app's hash or run your own copy.
4. Check fingerprints before your first share to a handle.
5. Rotate any secret after sharing it, if that matters.

## Verifying the app

```sh
curl -s https://rspm.me/ | shasum -a 256
# compare with the hash published for the release tag on GitHub, or:
git checkout vX.Y.Z && node tools/build.js && shasum -a 256 dist/rspm.me/index.html
```

Remember that a matching hash from your own `curl` proves what *you* received,
not what every user received. Saving a verified file locally is the strongest
option.
