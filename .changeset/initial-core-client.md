---
'@adonis-agora/crypto-core': minor
'@adonis-agora/crypto-client': minor
---

The first release of the Agora crypto wire contract and client.

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
