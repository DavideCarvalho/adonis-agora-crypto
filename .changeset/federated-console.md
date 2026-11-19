---
"@adonis-agora/crypto": minor
"@adonis-agora/crypto-dashboard": minor
---

Federated console. An app that runs crypto standalone (its own store and root key) can appear in another app's console: the console lists it in `console.federatedApps`, reads its key metadata, versions and audit straight from its tables (never the `material` column: a new `metadataOnly` Lucid store), and sends every key operation (create, rotate, policy, delete, test, rewrap; never export) to the app over Redis. The owning app opts in with `consoleCommands` (`actions`, `capabilities`) and runs each operation through its own service and audit, with the other console's viewer as the actor and `console:<appLabel>` as the client; the console's `authorize` may narrow it with a new `capabilities` field. New routes: `GET /api/apps`, `POST /api/keys/:name/test` (a probe round trip, audited, no plaintext), `POST /api/keys/:name/rewrap`. The App picker shows a federated badge and notice, a Test button on the key page, and a read-only federated app disables the key operations.
