# @adonis-agora/crypto-core

## 1.0.0-rc.0

### Major Changes

- [#40](https://github.com/DavideCarvalho/adonis-agora-crypto/pull/40) [`c72dc96`](https://github.com/DavideCarvalho/adonis-agora-crypto/commit/c72dc968e997b91eddb9c3b00f014bb8fc6b4ccd) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - 1.0 release candidate: crypto joins the rest of the Agora libraries on the 1.x line. One breaking change: the deprecated `ctx.cryptoEnvelope` alias is gone; read the opened envelope from `ctx.agora.envelope`.

## 0.7.2

### Patch Changes

- [#34](https://github.com/DavideCarvalho/adonis-agora-crypto/pull/34) [`20970e7`](https://github.com/DavideCarvalho/adonis-agora-crypto/commit/20970e751ec9291ba284894aff25f5f3c8b4ac4c) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - The key and data key stores, the broker transports (when handed an `@adonisjs/redis` connection) and `cryptoServerKms` now describe the infrastructure they use (`Symbol.for('@adonis-agora/stack')`), and the `defineConfig` result describes the default Lucid stores, so telescope's Architecture page shows "crypto: keys → PostgreSQL" without any app code.

## 0.7.1

### Patch Changes

- [#31](https://github.com/DavideCarvalho/adonis-agora-crypto/pull/31) [`dba00e2`](https://github.com/DavideCarvalho/adonis-agora-crypto/commit/dba00e2daf27ebac2f66fa62c2eb8a1b9c6befa1) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - `capabilityAllows`: a `*` before the last one now needs a segment to consume, so `crypto:*:*` no longer matches `crypto`. Only the last `*` may match nothing. The other Agora libs use the same rule.

## 0.7.0

### Minor Changes

- [#28](https://github.com/DavideCarvalho/adonis-agora-crypto/pull/28) [`409e8bd`](https://github.com/DavideCarvalho/adonis-agora-crypto/commit/409e8bd8d77624c36e7341c8ba022187bb0583a9) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - The audit trail pages by cursor, so a deep page costs the same as the first and no request counts the whole trail.
  
  - `GET /v1/audit` (and the console's `/api/audit`) accept `first`/`after` (or `last`/`before`) and answer `{ data, meta: { nextCursor, prevCursor, hasNext, hasPrev } }`, seeking on `(at, id)` with no `COUNT(*)`. `page`/`size` keep working and keep the offset envelope with its total.
  - `CryptoClient.auditCursor({ size, after, before, ...filters })` walks it from a tenant; `client.audit()` is unchanged.
  - The console's Audit page walks by cursor: Previous/Next, the walked cursors in the URL (`#/audit?after=…`), so back/forward and shared links still work. It no longer shows a row total.
  - Stores gain an optional `seekAudit` (both built-in stores implement it). The in-memory store's `listAudit` now orders ties on `at` by `id`, like the SQL store.
  - New migration `add_crypto_audit_filter_indexes` (published by `configure`): one index per audit filter (key, operation, result, actor) plus `(app, at, id)`, built `CONCURRENTLY` on Postgres. Opt-in: run it once on existing installs (see Getting started).
  - Fix: `node ace add @adonis-agora/crypto` failed while publishing its stubs (no destination, and backticks the stub template could not compile); the config and migration stubs now publish.

## 0.6.0

### Minor Changes

- [#24](https://github.com/DavideCarvalho/adonis-agora-crypto/pull/24) [`c305626`](https://github.com/DavideCarvalho/adonis-agora-crypto/commit/c3056266b0b979d5875165eb736adc7c3336ff33) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Control-plane attribution, per-viewer console apps and a lazy tenant URL.
  
  - **Diagnostics events.** With `@adonis-agora/diagnostics` installed, crypto publishes
    `agora:crypto:<event>` (`encrypt`, `decrypt`, `rewrap`, `datakey`, `sign`, `verify`, `hmac`,
    `keys.create|rotate|policy|delete|export`, `denied`, `subjects.forget`, `subjects.cache`), with
    `app` on the envelope set to the partition the operation acted on: the tenant of the verified token
    on a control plane, the app itself when standalone. A tenant publishes only what the control plane
    cannot see (subject data-key cache misses, and the local half of `forget`). Payloads carry the key
    name, outcome, error code, sizes and duration, never plaintext, ciphertext, key material, AAD or
    audit context. Diagnostics is read through its global slot; no new dependency.
  - **Console apps per viewer.** `console.authorize` may answer `{ allowed: true, apps: '*' | string[] }`
    (the same shape as the telescope and flags consoles). The picker, every console API call, the ⌘K
    search and the MCP dev tools stay inside the grant; `console.apps` remains the upper bound.
    `authorizeByToken` takes `apps`.
  - **Lazy tenant URL.** `tenant.url` and `transports.http({ url })` accept
    `() => Promise<string>` (with an optional `refresh()`), such as authkit-client's
    `controlPlaneUrl(...)`. It is resolved before the first call and in `agora:doctor`, and looked up
    again after a connection error or a bare 404. `createCryptoClient({ url })` in crypto-core takes the
    same, adds `client.resolveUrl()`, and `client.url` is `''` until a lazy URL resolves.

## 0.5.0

### Minor Changes

- [#23](https://github.com/DavideCarvalho/adonis-agora-crypto/pull/23) [`f0bd3d6`](https://github.com/DavideCarvalho/adonis-agora-crypto/commit/f0bd3d61431a2a06360d5e4b0c0c2f2f7637849a) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - `capabilityAllows` accepts a key-name prefix. In the key-name segment only (`crypto:<op>:<key>`,
  `crypto:keys:<scope>:<key>`), a segment ending in `*` after a prefix (`crypto:decrypt:subject_*`)
  matches a key name that starts with that prefix (`subject_42`), and nothing else. Prefixes in other
  segments (`crypto:d*:x`, `crypto:keys:m*`) match nothing. A bare `*` keeps its meaning. A token can now be limited to one family of keys,
  such as the per-subject keys of `crypto.subjects`.

## 0.4.1

### Patch Changes

- [#21](https://github.com/DavideCarvalho/adonis-agora-crypto/pull/21) [`eccec14`](https://github.com/DavideCarvalho/adonis-agora-crypto/commit/eccec14f43987d623ddf727a17449ecc8b7b07c2) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Declare independent versioning on every published crypto package:
  `"agora": { "versioning": "independent" }`.
  
  `agora:doctor`'s "Agora versions line up" check warns when a 0.x Agora package sits next to the 1.x rc
  libs, which is a false positive for these packages: they keep their own 0.x line on purpose. The
  doctor already honours the marker (it is how `@adonis-agora/cms` and `authkit-poppy` opt out); the
  packages just were not declaring it. `crypto-dashboard` already did.

## 0.4.0

### Minor Changes

- [#15](https://github.com/DavideCarvalho/adonis-agora-crypto/pull/15) [`1d70131`](https://github.com/DavideCarvalho/adonis-agora-crypto/commit/1d70131ca1cbb9f2b95542f3acf25b1faf3f42e0) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Pluggable tenant ↔ control-plane transports for the call channel.
  
  `transports.http({ url, fetch?, timeoutMs? })` is the default (an app that configures nothing is
  unchanged) and `transports.redis({ connection, prefix?, timeoutMs? })` is the first broker driver:
  the tenant pushes the envelope on `<prefix>:requests` and blocks on `<prefix>:reply:<id>`, the
  control plane consumes the same list and answers there. Both sides take the same driver via
  `transport` in `config/crypto.ts` (tenant) and on the control-plane config.
  
  Every message carries the tenant token and a message id; `verifyTenant` runs on each message, the
  partition and capabilities come only from the verified token, ids are deduped per partition, payloads
  are capped at 512 KiB, messages older than 5 minutes are refused, calls time out, and poison messages
  are dead-lettered instead of retried forever.
  
  The choice is server-to-server only: the browser (`crypto-react`, the console) always talks HTTP, the
  control plane keeps its HTTP API mounted whatever tenant transport is configured, and a fleet can mix
  HTTP and brokered tenants — covered by a test. `queue`, `bullmq` and `durable` are the next drivers,
  on the `transports.broker(...)` seam the Redis driver implements.

## 0.3.0

### Minor Changes

- [#14](https://github.com/DavideCarvalho/adonis-agora-crypto/pull/14) [`ef09ac8`](https://github.com/DavideCarvalho/adonis-agora-crypto/commit/ef09ac86208132eba42e25fc6ddac111fe5e964b) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - The tenant side lives in `@adonis-agora/crypto`, like every other Agora lib.
  
  `@adonis-agora/crypto-client` is gone. The typed client, `cryptoServerKms`, `cryptoEnvelope`/
  `cryptoFetch` and `cryptoServerSigner` moved to `@adonis-agora/crypto-core` (the only piece a worker,
  a script or a non-Adonis service needs — it never imports `@adonisjs/core`), and `@adonis-agora/crypto`
  re-exports them. A tenant now installs one package and picks its role with `topology: 'tenant'` in
  `config/crypto.ts`; `services/main` gives the same API in `standalone`, `control-plane` and `tenant`.
  
  `@adonis-agora/crypto-integrations` and `@adonis-agora/crypto-react` import from `crypto`/`crypto-core`,
  never from a separate client package. Docs got the same "Central server" shape as flags (control
  plane, tenant, moving from standalone, end-to-end example). `@adonis-agora/crypto-client` is deprecated
  on npm; its last version keeps working.

## 0.2.0

### Minor Changes

- [#12](https://github.com/DavideCarvalho/adonis-agora-crypto/pull/12) [`ab8292a`](https://github.com/DavideCarvalho/adonis-agora-crypto/commit/ab8292a52527a7408d5c4ab36043b0325139b86f) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Auditable opens: an operation can carry `context`.
  
  `decrypt`, `rewrap` and `generateDataKey` accept an optional `context` (`user:42`, `grant:7`, `boot`),
  recorded on the audit row as `metadata.context` — including on refusals, so a probe is traceable. It is
  never encrypted, so it must not hold the plaintext or a secret; a value longer than 200 characters or
  with control characters is refused. `DecryptInput`/`RewrapInput`/`DataKeyInput` gained the field, and
  `crypto:decrypt` gained `--context`.
  
  `configCrypto` sends the entry path (`config:<app>:<environment>:<label>:<key>`) as the context, so the
  crypto audit of a server-held config secret says which entry was opened.
