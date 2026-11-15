# @adonis-agora/crypto-core

The wire contract of the Agora crypto server: key types (`aes256-gcm`, `x25519`, `ed25519`,
`hmac-sha256`), the `urn:agora:crypto` resource, the capability grammar
(`crypto:encrypt:<key>`, `crypto:keys:manage`, `*` wildcards), every request/answer shape, the Agora
page envelope and the shared error codes.

No AdonisJS dependency: the wire contract **and** the typed client (tenant side, envelope fetch,
KMS adapter, remote signer) live here, so a worker, a script or a non-Adonis service can talk to a
crypto server without pulling `@adonisjs/core`.

```ts
import { capabilityAllows, CRYPTO_SCOPES, cryptoScope } from '@adonis-agora/crypto-core'

capabilityAllows(['crypto:encrypt:*'], cryptoScope('encrypt', 'media')) // true
```

Docs: <https://davidecarvalho.github.io/agora/docs/crypto>
