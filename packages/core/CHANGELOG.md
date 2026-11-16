# @adonis-agora/crypto-core

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
