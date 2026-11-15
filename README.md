# adonis-crypto

A crypto server and client for AdonisJS apps — think HashiCorp Vault Transit or a small KMS. One app
holds named, versioned keys; every other app asks it to encrypt, decrypt, sign or produce a data key,
and no key material ever leaves the server. Part of the [Agora](https://davidecarvalho.github.io/agora)
ecosystem.

```
packages/core       @adonis-agora/crypto-core      wire contracts, key types, capabilities
packages/client     @adonis-agora/crypto-client    typed client, KMS adapter, remote signer
packages/adonis     @adonis-agora/crypto           the server: keys, operations, audit, HTTP API
packages/dashboard  @adonis-agora/crypto-dashboard the console (React SPA)
```

```sh
node ace add @adonis-agora/crypto
```

```ts title="config/crypto.ts (the server)"
import { defineConfig, sharedSecretVerifier } from '@adonis-agora/crypto'

export default defineConfig({
  topology: 'control-plane',
  verifyTenant: sharedSecretVerifier({
    partitions: { streaming: env.get('CRYPTO_SECRET_STREAMING') },
  }),
})
```

```ts title="config/crypto.ts (an app)"
import { defineConfig } from '@adonis-agora/crypto'

export default defineConfig({
  topology: 'tenant',
  tenant: {
    url: env.get('CRYPTO_URL'),         // https://crypto.example.com/_crypto
    partition: 'streaming',
    token: env.get('CRYPTO_TOKEN'),
  },
})
```

```ts
import crypto from '@adonis-agora/crypto/services/main'

const { ciphertext } = await crypto.encrypt({ key: 'pii', plaintext: email })
const { plaintext } = await crypto.decrypt({ key: 'pii', ciphertext })
```

- **Keys** are named per app (partition), typed `aes256-gcm`, `x25519`, `ed25519` or `hmac-sha256`,
  and versioned: rotating adds a version, and old ciphertext keeps opening down to
  `minDecryptionVersion`.
- **Operations** over HTTP (`/_crypto/v1/...`) or in process: encrypt, decrypt, rewrap (no plaintext
  back), generate data key (envelope), sign, verify, hmac, public key / JWKS, with batch variants.
- **Key material at rest is never plain**: sealed by the Agora crypto kit, rooted in the app's
  encryption service or a cloud KMS (`KmsAdapter`).
- **Authorization** comes from the verified tenant token: `crypto:encrypt:<key>`,
  `crypto:decrypt:<key>`, `crypto:sign:<key>`, `crypto:keys:manage`, …, with `*` wildcards.
- **Everything is audited** — who, app, key, version, operation, result — never the plaintext.
- **The server is a KMS root** for every Agora lib: `cryptoServerKms({ client, key })` plugs into
  the crypto kit's envelope encryption, so config, authkit and agent keep no key material.

Docs: <https://davidecarvalho.github.io/agora/docs/crypto>

## Development

```sh
pnpm install
pnpm build
pnpm test
pnpm lint
```
