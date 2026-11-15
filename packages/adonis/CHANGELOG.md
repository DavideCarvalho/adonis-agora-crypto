# @adonis-agora/crypto

## 0.3.0

### Minor Changes

- [#4](https://github.com/DavideCarvalho/adonis-agora-crypto/pull/4) [`c0cb4b4`](https://github.com/DavideCarvalho/adonis-agora-crypto/commit/c0cb4b4aa6a3f7a7eb8bd8efe321c2d9c1ce3c2f) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Encrypted service-to-service requests, and public-key export for sharing.
  
  `cryptoFetch({ client, key })` is a drop-in `fetch` that seals the JSON request body into an
  envelope (`{ agoraEnvelope }` + `x-crypto-envelope: v1`) and opens an encrypted response. Any client
  that takes a `fetch` option — the flags, durable and config clients included — is encrypted by
  configuration only. Bodies that are not JSON (`FormData`, bytes, streams) pass through untouched.
  
  `cryptoEnvelopeMiddleware({ service, partition, key })` (or `{ client }` on a tenant) decrypts an
  envelope before the controller runs and replaces the request body, so `request.body()`,
  `request.all()` and `request.validateUsing()` read the payload with no controller change;
  `cryptoEnvelopeReply()` answers encrypted. Envelopes carry `iat` (stale/future ones are refused), bind
  an optional `aad` context, and fail with `{ error, code }` — never a half-decrypted body. Every seal
  and open is audited by the crypto server.
  
  Also: `crypto:keys:public-key <name> [--jwks]` prints an asymmetric key's public JWK/JWKS for
  registering a recipient, and the doctor checks now skip instead of throwing when the app was not
  booted (`agora:doctor --no-boot`).
  
  Docs: [encrypted requests](/docs/crypto/transport) and [sharing with a person](/docs/crypto/sharing).

### Patch Changes

- Updated dependencies [[`c0cb4b4`](https://github.com/DavideCarvalho/adonis-agora-crypto/commit/c0cb4b4aa6a3f7a7eb8bd8efe321c2d9c1ce3c2f)]:
  - @adonis-agora/crypto-client@0.2.0

## 0.2.0

### Minor Changes

- [#3](https://github.com/DavideCarvalho/adonis-agora-crypto/pull/3) [`66b13f2`](https://github.com/DavideCarvalho/adonis-agora-crypto/commit/66b13f29efa58016205520efbdf276c6dabde65c) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - The crypto console and the operator tooling.
  
  `@adonis-agora/crypto-dashboard` is the Agora console (copied console kit, teal accent): an overview
  with the keys, versions, operations and refusals of the last 24h, the key list with create/rotate/
  delete, a key page with the policy editor (decryption floor, deletion, export) and every version's
  status, and the audit trail with filters. It is metadata only — no key material, no plaintext, no
  export button.
  
  The server mounts it at the tenant API's path (`/_crypto`, JSON API under `/_crypto/api`), gated by
  `console.authorize`, registers itself in the `agora.consoles` switcher and its ⌘K search, and exposes
  four **metadata-only** dev tools on the agent hub (`crypto_list_keys`, `crypto_get_key`,
  `crypto_list_audit`, `crypto_overview`) — never an encrypt/decrypt/sign/export tool.
  
  CLI: `crypto:keys:list|show|create|rotate|policy|delete|export|reseal`, `crypto:encrypt`,
  `crypto:decrypt` (with `--value-file`/`--stdin` so a secret does not land in the shell history) and
  `crypto:audit`, all through the same service as the console and the API with `cli:<os user>` as the
  actor. `crypto:keys:reseal [--dry-run] [--all]` moves key material to a rotated root key without
  touching keys, versions or ciphertext.
  
  `agora:doctor` gains five checks: the keyring, the store, every key version opening with the current
  root (a lost root is an error, a retired one a warning), the tenant's reachability and token, and the
  console's gate in production.

## 0.1.0

### Minor Changes

- [#2](https://github.com/DavideCarvalho/adonis-agora-crypto/pull/2) [`744e7e8`](https://github.com/DavideCarvalho/adonis-agora-crypto/commit/744e7e8d7206422af086812a6eceb5287a885636) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - The first release of the Agora crypto server: a small HashiCorp Vault Transit for AdonisJS.
  
  Named keys per app (partition) with four types (`aes256-gcm`, `x25519`, `ed25519`, `hmac-sha256`)
  and real versions: `rotate` adds one, ciphertext names the version that sealed it, old data keeps
  opening down to `minDecryptionVersion`, and `rewrap` moves it to the latest without returning the
  plaintext. `deletionAllowed` and `exportable` are off by default.
  
  Operations over HTTP (`/_crypto/v1/...`) or in process (standalone): encrypt, decrypt, rewrap,
  generate a data key (plaintext + wrapped, or wrapped only), sign, verify, hmac, public key/JWKS,
  and batch variants. Key material at rest is sealed by the Agora crypto kit — rooted in the app's
  `config/encryption.ts` by default, or in `crypto.keys`, or in a cloud `KmsAdapter` — and never
  stored plain.
  
  Tenant auth follows the Agora topology spec: `verifyTenant` top level with the three forms,
  `urn:agora:crypto`, a `partition` claim and per-key capabilities. With authkit it is
  `authkitTenantVerifier` (optional, lazy); without it, `sharedSecretVerifier`. Every operation and
  key-management action is audited (who, app, key, version, operation, result) — never the plaintext
  or the key material — and a refusal is audited too.
  
  Three topologies with the same calls: `standalone` (in process), `control-plane` (the server) and
  `tenant` (the app calls the server), so an app moves from local to central by changing
  `config/crypto.ts` only.
