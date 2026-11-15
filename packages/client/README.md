# @adonis-agora/crypto-client

A remote-safe client for an `@adonis-agora/crypto` server: every operation, a shared secret or
`authkitTenantToken`, timeouts and retries — plus the two pieces other Agora libs use.

```ts
import { createCryptoClient, cryptoServerKms } from '@adonis-agora/crypto-client'

const client = createCryptoClient({ url, partition: 'streaming', token })
const { ciphertext } = await client.encrypt({ key: 'media', plaintext: 'x' })

// The crypto server as the KMS root of any Agora lib's crypto kit:
const kms = cryptoServerKms({ client, key: 'fleet-root' })
```

- `cryptoServerKms({ client, key })` — a crypto-kit `KmsAdapter`; the keyring's `purpose` is bound as
  AAD, so a data key wrapped for one purpose cannot be unwrapped for another.
- `cryptoServerSigner({ client, key })` — detached Ed25519 signatures (`agora:sig1:<kid>:…`) from a
  key that never leaves the server.

Docs: <https://davidecarvalho.github.io/agora/docs/crypto/kms>
