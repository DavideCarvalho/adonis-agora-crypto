---
'@adonis-agora/crypto': minor
'@adonis-agora/crypto-core': minor
'@adonis-agora/crypto-integrations': minor
---

The tenant side lives in `@adonis-agora/crypto`, like every other Agora lib.

`@adonis-agora/crypto-client` is gone. The typed client, `cryptoServerKms`, `cryptoEnvelope`/
`cryptoFetch` and `cryptoServerSigner` moved to `@adonis-agora/crypto-core` (the only piece a worker,
a script or a non-Adonis service needs — it never imports `@adonisjs/core`), and `@adonis-agora/crypto`
re-exports them. A tenant now installs one package and picks its role with `topology: 'tenant'` in
`config/crypto.ts`; `services/main` gives the same API in `standalone`, `control-plane` and `tenant`.

`@adonis-agora/crypto-integrations` and `@adonis-agora/crypto-react` import from `crypto`/`crypto-core`,
never from a separate client package. Docs got the same "Central server" shape as flags (control
plane, tenant, moving from standalone, end-to-end example). `@adonis-agora/crypto-client` is deprecated
on npm; its last version keeps working.
