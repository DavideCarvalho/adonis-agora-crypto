# @adonis-agora/crypto-client

## 0.2.0

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

## 0.1.0

### Minor Changes

- [#1](https://github.com/DavideCarvalho/adonis-agora-crypto/pull/1) [`c70ddcc`](https://github.com/DavideCarvalho/adonis-agora-crypto/commit/c70ddccd20125ea2ece95f170bebf823456dcf82) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - The first release of the Agora crypto wire contract and client.
  
  `@adonis-agora/crypto-core` defines what a key is (`aes256-gcm`, `x25519`, `ed25519`,
  `hmac-sha256`), the capability vocabulary (`crypto:encrypt:<key>`, `crypto:decrypt:<key>`,
  `crypto:sign:<key>`, `crypto:keys:read|manage|export`, with `*` wildcards), the `urn:agora:crypto`
  resource, and every request/answer shape plus the shared error codes.
  
  `@adonis-agora/crypto-client` is the remote-safe client: every operation (encrypt, decrypt, rewrap,
  data key, sign, verify, hmac, public key/JWKS, key management, audit) over HTTP with a shared secret
  or `authkitTenantToken` from `@adonis-agora/authkit-client`, timeouts and retries, a token reset on
  `401`; plus the two pieces other Agora libs use: `cryptoServerKms({ client, key })`, a crypto-kit
  `KmsAdapter` that makes a crypto server the root of any lib's envelope encryption, and
  `cryptoServerSigner({ client, key })`, a detached Ed25519 signer whose key never leaves the server.

### Patch Changes

- Updated dependencies [[`c70ddcc`](https://github.com/DavideCarvalho/adonis-agora-crypto/commit/c70ddccd20125ea2ece95f170bebf823456dcf82)]:
  - @adonis-agora/crypto-core@0.1.0
