# @adonis-agora/crypto-core

## 1.0.0

### Major Changes

- [#40](https://github.com/DavideCarvalho/adonis-agora-crypto/pull/40) [`c72dc96`](https://github.com/DavideCarvalho/adonis-agora-crypto/commit/c72dc968e997b91eddb9c3b00f014bb8fc6b4ccd) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - 1.0 release candidate: crypto joins the rest of the Agora libraries on the 1.x line. One breaking change: the deprecated `ctx.cryptoEnvelope` alias is gone; read the opened envelope from `ctx.agora.envelope`.

### Minor Changes

- [`ede8939`](https://github.com/DavideCarvalho/adonis-agora-crypto/commit/ede8939d298d3a611dc172bb2e0c8b58b971f45f) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Security: federated console commands are authenticated. Before, anyone who could publish on the app's Redis could rotate, delete or re-policy its keys (flip `exportable` / `deletionAllowed`) with any actor and capabilities, and forge the answers.
  
  **Breaking:** an app's `consoleCommands` must resolve a mode, or its web process fails at boot with the line to add (ace commands are not affected). The console side needs nothing:
  
  - **Crypto, automatic on the console:** the console (which always runs a crypto server) seals every command with its own `aes256-gcm` key `console-crypto` in the federated app's partition, created at boot (`controlPlane.crypto: false` turns that off). The owning app opens it with `consoleCommands.crypto: { cipher }`, a client of the console's crypto server for its partition, with no grant: a crypto server lets an app decrypt with the `console-*` keys of its own partition implicitly (decrypt only, never another partition's; an explicit `crypto:decrypt:console-*` is harmless). The app cannot pick this by itself: it runs its own crypto server, not the console's. `crypto.owns` lets a third-party cipher (KMS, Vault, HSM) recognize its ciphertext format.
  - **authkit app-call tokens, automatic:** with `@adonis-agora/authkit-client` booted (`apps` on the console, `service` on the app), each command carries the console app's app-call token and the app verifies it; what authkit granted the console app on the app (`crypto:console:*`, or finer) caps it. `controlPlane.token: false` / `consoleCommands.verifyTenant: false` turn it off.
  - **Token (explicit):** `controlPlane.token` + `consoleCommands.verifyTenant` (a control plane falls back to its own), sealed to the app's own X25519 `console-commands` key, read from the app's store.
  - **Shared secret:** the same `secret` on both sides (HMAC on every command and answer).
  
  In every mode commands over a minute old and replays are refused, answers are authenticated, and a refused token answers `401`. Also breaking: the default crypto key is renamed `crypto-console` → `console-crypto`; a control plane's `consoleCommands` serves no partition until `partitions` lists them; an app refuses a command without capabilities (403, code `capabilities-required`; the console always sends the viewer's, narrowed to the crypto console set, the whole set when `authorize` does not narrow); `crypto:console:read` / `:write` / `:*` work as aliases on tokens and viewer capabilities (compared literally); refusals name who lacks the capability (the viewer, the console's token, or the app's `consoleCommands.capabilities`); no console command may touch the `console-commands` or crypto-mode key.
  
  **Breaking (console):** the console's own partitions now honor `authorize`'s `capabilities` (before, only federated commands did, so a viewer granted `crypto:keys:read` could still create, rotate, re-policy and delete keys locally). Create, rotate, policy and delete need `crypto:keys:manage` (403 with a clear message), a test the key's operations, a rewrap `crypto:rewrap:<key>`; reading metadata and the audit stays allowed to everyone let in. An `authorize` that returns no `capabilities` keeps the whole console set. `authorize` answers take the shape shared by every Agora console (`{ allowed, apps?, tenants?, capabilities?, access? }`; malformed `capabilities` grant nothing, `access: 'read'` keeps reading only (no key test), `anyAuthorize` keeps the deciding grant); `authorizeByToken` takes the same grant (`access`, `apps`, `tenants`, `capabilities`). `/meta` returns the viewer's `capabilities` and the page disables what the viewer may not do.
  
  New: `encrypt` takes an optional `partition` to seal with another partition's key (HTTP, broker transports, service, `CryptoClient`): encrypt only, with an explicit `crypto:seal:<key>` grant (`crypto:*` does not count), audited in the target partition. Every other operation refuses another partition. Clients report a server that predates it instead of returning an unopenable ciphertext. A missing `console-*` key in the target partition is created there (`aes256-gcm`) by the first seal, audited as a creation by the sealing caller (`metadata.provisionedBy: 'seal'`), so separate apps coordinate console keys by themselves; `sealProvisioning: false` turns that off.
  
  New doctor checks: `crypto.console-commands` (resolved modes, error when unauthenticated) and `crypto.console-commands-key` (deep: keys exist and round-trip).
  
  New: `hasKey({ key })` on every crypto operations surface (in process, `CryptoClient`, the broker transports; `POST /v1/has-key`): whether a key exists in the caller's own partition, with decrypt's authorization (an app's own `console-*` keys need none), `false` when missing, never audited. The console key checks use it instead of a decrypt probe, so a boot no longer writes `decrypt` error rows. In crypto mode an automatic authkit app-call token that cannot be minted no longer blocks a command: it goes crypto-only, with one warning naming the grant, and is retried after 5 minutes.

- [#41](https://github.com/DavideCarvalho/adonis-agora-crypto/pull/41) [`c88b503`](https://github.com/DavideCarvalho/adonis-agora-crypto/commit/c88b503985d874a571c52ba5ee10b05ea32c50a7) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Keys now carry `updatedAt` / `updatedBy` from the moment they are created (equal to `createdAt` /
  `createdBy`), so every key shows both timestamps; rotations, policy changes and deletes keep moving
  `updatedAt`. Key versions and the audit trail stay append-only (`createdAt` / `at` only). The
  console's key detail always shows Created and Updated (`—` when a key never recorded one), the key
  list's Created cell carries the full timestamp in its tooltip, and `crypto:keys:list` /
  `crypto:keys:show` print the timestamps too. No schema change: the columns already existed.

## 1.0.0-rc.2

### Minor Changes

- [`ede8939`](https://github.com/DavideCarvalho/adonis-agora-crypto/commit/ede8939d298d3a611dc172bb2e0c8b58b971f45f) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Security: federated console commands are authenticated. Before, anyone who could publish on the app's Redis could rotate, delete or re-policy its keys (flip `exportable` / `deletionAllowed`) with any actor and capabilities, and forge the answers.
  
  **Breaking:** an app's `consoleCommands` must resolve a mode, or its web process fails at boot with the line to add (ace commands are not affected). The console side needs nothing:
  
  - **Crypto, automatic on the console:** the console (which always runs a crypto server) seals every command with its own `aes256-gcm` key `console-crypto` in the federated app's partition, created at boot (`controlPlane.crypto: false` turns that off). The owning app opens it with `consoleCommands.crypto: { cipher }`, a client of the console's crypto server for its partition, with no grant: a crypto server lets an app decrypt with the `console-*` keys of its own partition implicitly (decrypt only, never another partition's; an explicit `crypto:decrypt:console-*` is harmless). The app cannot pick this by itself: it runs its own crypto server, not the console's. `crypto.owns` lets a third-party cipher (KMS, Vault, HSM) recognize its ciphertext format.
  - **authkit app-call tokens, automatic:** with `@adonis-agora/authkit-client` booted (`apps` on the console, `service` on the app), each command carries the console app's app-call token and the app verifies it; what authkit granted the console app on the app (`crypto:console:*`, or finer) caps it. `controlPlane.token: false` / `consoleCommands.verifyTenant: false` turn it off.
  - **Token (explicit):** `controlPlane.token` + `consoleCommands.verifyTenant` (a control plane falls back to its own), sealed to the app's own X25519 `console-commands` key, read from the app's store.
  - **Shared secret:** the same `secret` on both sides (HMAC on every command and answer).
  
  In every mode commands over a minute old and replays are refused, answers are authenticated, and a refused token answers `401`. Also breaking: the default crypto key is renamed `crypto-console` → `console-crypto`; a control plane's `consoleCommands` serves no partition until `partitions` lists them; an app refuses a command without capabilities (403, code `capabilities-required`; the console always sends the viewer's, narrowed to the crypto console set, the whole set when `authorize` does not narrow); `crypto:console:read` / `:write` / `:*` work as aliases on tokens and viewer capabilities (compared literally); refusals name who lacks the capability (the viewer, the console's token, or the app's `consoleCommands.capabilities`); no console command may touch the `console-commands` or crypto-mode key.
  
  **Breaking (console):** the console's own partitions now honor `authorize`'s `capabilities` (before, only federated commands did, so a viewer granted `crypto:keys:read` could still create, rotate, re-policy and delete keys locally). Create, rotate, policy and delete need `crypto:keys:manage` (403 with a clear message), a test the key's operations, a rewrap `crypto:rewrap:<key>`; reading metadata and the audit stays allowed to everyone let in. An `authorize` that returns no `capabilities` keeps the whole console set. `authorize` answers take the shape shared by every Agora console (`{ allowed, apps?, tenants?, capabilities?, access? }`; malformed `capabilities` grant nothing, `access: 'read'` keeps reading only (no key test), `anyAuthorize` keeps the deciding grant); `authorizeByToken` takes the same grant (`access`, `apps`, `tenants`, `capabilities`). `/meta` returns the viewer's `capabilities` and the page disables what the viewer may not do.
  
  New: `encrypt` takes an optional `partition` to seal with another partition's key (HTTP, broker transports, service, `CryptoClient`): encrypt only, with an explicit `crypto:seal:<key>` grant (`crypto:*` does not count), audited in the target partition. Every other operation refuses another partition. Clients report a server that predates it instead of returning an unopenable ciphertext. A missing `console-*` key in the target partition is created there (`aes256-gcm`) by the first seal, audited as a creation by the sealing caller (`metadata.provisionedBy: 'seal'`), so separate apps coordinate console keys by themselves; `sealProvisioning: false` turns that off.
  
  New doctor checks: `crypto.console-commands` (resolved modes, error when unauthenticated) and `crypto.console-commands-key` (deep: keys exist and round-trip).
  
  New: `hasKey({ key })` on every crypto operations surface (in process, `CryptoClient`, the broker transports; `POST /v1/has-key`): whether a key exists in the caller's own partition, with decrypt's authorization (an app's own `console-*` keys need none), `false` when missing, never audited. The console key checks use it instead of a decrypt probe, so a boot no longer writes `decrypt` error rows. In crypto mode an automatic authkit app-call token that cannot be minted no longer blocks a command: it goes crypto-only, with one warning naming the grant, and is retried after 5 minutes.

## 1.0.0-rc.1

### Minor Changes

- [#41](https://github.com/DavideCarvalho/adonis-agora-crypto/pull/41) [`c88b503`](https://github.com/DavideCarvalho/adonis-agora-crypto/commit/c88b503985d874a571c52ba5ee10b05ea32c50a7) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Keys now carry `updatedAt` / `updatedBy` from the moment they are created (equal to `createdAt` /
  `createdBy`), so every key shows both timestamps; rotations, policy changes and deletes keep moving
  `updatedAt`. Key versions and the audit trail stay append-only (`createdAt` / `at` only). The
  console's key detail always shows Created and Updated (`—` when a key never recorded one), the key
  list's Created cell carries the full timestamp in its tooltip, and `crypto:keys:list` /
  `crypto:keys:show` print the timestamps too. No schema change: the columns already existed.

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
