# @adonis-agora/crypto-react

The asymmetric half of `@adonis-agora/crypto` in the browser: an X25519 identity, `sealTo` /
`openWith` byte-compatible with the Agora crypto kit, a passphrase-sealed private key, and React
hooks.

```ts
import { createBrowserIdentity, sealBrowserIdentity, sealTo, openWith } from '@adonis-agora/crypto-react'

const identity = createBrowserIdentity()          // register identity.publicKey with the app
const sealed = await sealBrowserIdentity(identity, passphrase)

const shared = sealTo(doctor.publicKey, JSON.stringify({ examId }), { aad: `grant:${id}` })
const payload = JSON.parse(openWith(identity.privateKey, shared, { aad: `grant:${id}` }))
```

```tsx
import { CryptoProvider, useSealTo } from '@adonis-agora/crypto-react'

<CryptoProvider>
  <ShareButton />
</CryptoProvider>
```

Uses `@noble/curves`, `@noble/hashes` and `@noble/ciphers` (no Node built-ins), so it runs in any
modern browser, a worker or a test.

Docs: <https://davidecarvalho.github.io/agora/docs/crypto/react>
