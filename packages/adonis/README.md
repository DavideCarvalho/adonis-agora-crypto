# @adonis-agora/crypto

A crypto server and in-process service for AdonisJS — a small HashiCorp Vault Transit. Named,
versioned keys per app; encrypt, decrypt, rewrap, data keys, sign, verify and hmac over HTTP or in
process; capability-gated, fully audited, and a KMS root for the other Agora libs.

```sh
node ace add @adonis-agora/crypto
```

```ts
import crypto from '@adonis-agora/crypto/services/main'

const { ciphertext } = await crypto.encrypt({ key: 'media', plaintext: url })
const { plaintext } = await crypto.decrypt({ key: 'media', ciphertext })
```

Install `@adonisjs/lucid` for the default store (`stores.lucid()`), or use `stores.memory()`; the
key material is sealed with the Agora crypto kit (the app's `config/encryption.ts` by default).

Docs: <https://davidecarvalho.github.io/agora/docs/crypto>
