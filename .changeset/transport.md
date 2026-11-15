---
'@adonis-agora/crypto': minor
'@adonis-agora/crypto-client': minor
---

Encrypted service-to-service requests, and public-key export for sharing.

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
