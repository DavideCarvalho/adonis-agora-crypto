---
"@adonis-agora/crypto": patch
---

`node ace add @adonis-agora/crypto` (and `node ace configure @adonis-agora/crypto`) now runs the configure hook: the main entry exports `configure`, which Adonis looks for there. Before, it only warned "the module does not export the configure hook" and published nothing.

The published `create_crypto_tables` migration now uses `createTableIfNotExists`. `node ace migration:run` boots the provider, which creates the tables first (`autoCreateSchema` is on by default), so a fresh install failed with "table `crypto_keys` already exists".
