---
"@adonis-agora/crypto": minor
"@adonis-agora/crypto-core": minor
"@adonis-agora/crypto-dashboard": minor
---

The audit trail pages by cursor, so a deep page costs the same as the first and no request counts the whole trail.

- `GET /v1/audit` (and the console's `/api/audit`) accept `first`/`after` (or `last`/`before`) and answer `{ data, meta: { nextCursor, prevCursor, hasNext, hasPrev } }`, seeking on `(at, id)` with no `COUNT(*)`. `page`/`size` keep working and keep the offset envelope with its total.
- `CryptoClient.auditCursor({ size, after, before, ...filters })` walks it from a tenant; `client.audit()` is unchanged.
- The console's Audit page walks by cursor: Previous/Next, the walked cursors in the URL (`#/audit?after=…`), so back/forward and shared links still work. It no longer shows a row total.
- Stores gain an optional `seekAudit` (both built-in stores implement it). The in-memory store's `listAudit` now orders ties on `at` by `id`, like the SQL store.
- New migration `add_crypto_audit_filter_indexes` (published by `configure`): one index per audit filter (key, operation, result, actor) plus `(app, at, id)`, built `CONCURRENTLY` on Postgres. Opt-in: run it once on existing installs (see Getting started).
- Fix: `node ace add @adonis-agora/crypto` failed while publishing its stubs (no destination, and backticks the stub template could not compile); the config and migration stubs now publish.
