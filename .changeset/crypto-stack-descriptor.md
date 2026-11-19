---
"@adonis-agora/crypto": patch
"@adonis-agora/crypto-core": patch
---

The key and data key stores, the broker transports (when handed an `@adonisjs/redis` connection) and `cryptoServerKms` now describe the infrastructure they use (`Symbol.for('@adonis-agora/stack')`), and the `defineConfig` result describes the default Lucid stores, so telescope's Architecture page shows "crypto: keys → PostgreSQL" without any app code.
