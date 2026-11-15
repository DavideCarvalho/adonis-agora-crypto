---
'@adonis-agora/crypto': minor
---

The first release of the Agora crypto server: a small HashiCorp Vault Transit for AdonisJS.

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
