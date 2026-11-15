# @adonis-agora/crypto

## 0.9.1

### Patch Changes

- [#21](https://github.com/DavideCarvalho/adonis-agora-crypto/pull/21) [`eccec14`](https://github.com/DavideCarvalho/adonis-agora-crypto/commit/eccec14f43987d623ddf727a17449ecc8b7b07c2) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Declare independent versioning on every published crypto package:
  `"agora": { "versioning": "independent" }`.
  
  `agora:doctor`'s "Agora versions line up" check warns when a 0.x Agora package sits next to the 1.x rc
  libs, which is a false positive for these packages: they keep their own 0.x line on purpose. The
  doctor already honours the marker (it is how `@adonis-agora/cms` and `authkit-poppy` opt out); the
  packages just were not declaring it. `crypto-dashboard` already did.
- Updated dependencies [[`eccec14`](https://github.com/DavideCarvalho/adonis-agora-crypto/commit/eccec14f43987d623ddf727a17449ecc8b7b07c2)]:
  - @adonis-agora/crypto-core@0.4.1

## 0.9.0

### Minor Changes

- [#20](https://github.com/DavideCarvalho/adonis-agora-crypto/pull/20) [`0ddb3a0`](https://github.com/DavideCarvalho/adonis-agora-crypto/commit/0ddb3a007de5103c9b1497e7eea350b465225506) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - App-to-app encryption by configuration (the "hub" row of the Agora spec).
  
  `config/crypto.ts` gains `envelope`, and the provider installs both halves from that block alone — no
  app code and no `start/kernel.ts` edit:
  
  ```ts
  envelope: {
    key: 'svc-hub',                                   // the shared aes256-gcm key
    targets: { billing: 'https://billing.internal' }, // fallback when discovery is absent
  }
  ```
  
  - **outbound**: an undici interceptor **composed onto** the global dispatcher (never replacing it, so
    telescope's trace interceptor and authkit-client's token interceptor stay in the chain). Node 24's
    `fetch` reads `Symbol.for('undici.globalDispatcher.1')` while Node 26's bundled undici 8 reads `.2`, so
    the provider triggers the dispatcher's lazy install and composes onto every slot that exists, then
    proves it with a probe to a reserved `.invalid` origin — boot fails rather than send plaintext to an
    app it was told to seal. It seals the JSON body of a request to an app, identified through
    telescope's discovery slot `Symbol.for('@adonis-agora/discovery')` (`appOf`/`resolve`, read lazily —
    no import of telescope) and, when the slot is absent or does not know the origin, through the static
    `targets` map. Exact origins only; any other origin is untouched and crypto's own `/_crypto` API is
    never sealed. The seal is asynchronous and a failure is reported through undici's handler, so the
    request fails with the real cause and nothing clear is ever written.
  - **inbound**: a **server** middleware registered by the provider that opens the envelope before the
    body parser hands the body to the route. `request.body()`, `request.all()` and
    `request.validateUsing()` see the plaintext, and the opened state goes on the shared request context
    (`ctx.agora.envelope`, `{ key, issuedAt, payload }`; `ctx.cryptoEnvelope` stays as a deprecated
    alias). Every decrypt failure is one `400` with no detail leak, and the reason is logged server-side.
  
  Also fixes `requestHeaders`: it called Adonis' `request.headers()` detached from the request, so
  `verifyTenant` threw on every real HTTP request and the API answered `401` — the harness's fake request
  never reproduced it.

## 0.8.0

### Minor Changes

- [#19](https://github.com/DavideCarvalho/adonis-agora-crypto/pull/19) [`a119031`](https://github.com/DavideCarvalho/adonis-agora-crypto/commit/a11903133a9554ff9de81999512c532ce67b798d) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Durable as a transport driver.
  
  `transports.durable({ engine })` — or `{ gateway }` on a store-less durable tenant pod — sends the
  same call envelope as the other drivers and takes the **run result** as the reply, because durable's
  `start()` resolves with it: one line, no reply queue and no polling. `handleTransportCall(message)` is
  the server half: the same verify → dedupe → run path as `POST /_crypto/v1/transport`, so the control
  plane drops one file in `app/workflows/` (documented in `docs/transports.mdx`) and reuses its existing
  `verifyTenant`. `localStep` in the workflow body keeps the operation replay-safe.
  
  `tenant.transport` now accepts a broker driver directly (`transports.redis(...)`, `transports.bullmq(...)`,
  `transports.queue(...)`, `transports.durable(...)`): the shared envelope adapter is applied for you, so
  the documented config is the config that type-checks. `transports` is also exported from the package
  root, where the docs import it from.
  
  A failed run surfaces as `TransportError('unavailable')`; a run that never settles is a
  `TransportError('timeout')` (default `15000ms`, a workflow turn rather than a queue hop).

## 0.7.0

### Minor Changes

- [#18](https://github.com/DavideCarvalho/adonis-agora-crypto/pull/18) [`30d7526`](https://github.com/DavideCarvalho/adonis-agora-crypto/commit/30d7526874ce338c42fc78576161b11c45ea78d6) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - BullMQ and queue drivers for the call channel.
  
  `transports.bullmq({ connection, queueName?, prefix?, timeoutMs? })` uses BullMQ's own reply
  (`Queue.add()` + `job.waitUntilFinished(queueEvents)` resolves with the worker's return value), so the
  reply is the job result and a failed job is the dead-letter; bullmq is loaded lazily and
  `queue`/`queueEvents`/`worker` are injectable for tests.
  
  `transports.queue({ connection, dispatch, consume })` carries the request on `@adonisjs/queue` and the
  reply on the queue adapter's Redis (`<prefix>:reply:<id>`) because the Adonis queue has no
  await-result API; the app supplies its job's `dispatch` and its worker's consumer.
  
  Same envelope, token, dedupe, limits and dead-letter as the other drivers, and the same mixed-fleet
  rule: the browser always talks HTTP and the HTTP API stays mounted.

## 0.6.0

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

### Patch Changes

- Updated dependencies [[`1d70131`](https://github.com/DavideCarvalho/adonis-agora-crypto/commit/1d70131ca1cbb9f2b95542f3acf25b1faf3f42e0)]:
  - @adonis-agora/crypto-core@0.4.0

## 0.5.0

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

### Patch Changes

- Updated dependencies [[`ef09ac8`](https://github.com/DavideCarvalho/adonis-agora-crypto/commit/ef09ac86208132eba42e25fc6ddac111fe5e964b)]:
  - @adonis-agora/crypto-core@0.3.0

## 0.4.0

### Minor Changes

- [#12](https://github.com/DavideCarvalho/adonis-agora-crypto/pull/12) [`ab8292a`](https://github.com/DavideCarvalho/adonis-agora-crypto/commit/ab8292a52527a7408d5c4ab36043b0325139b86f) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Auditable opens: an operation can carry `context`.
  
  `decrypt`, `rewrap` and `generateDataKey` accept an optional `context` (`user:42`, `grant:7`, `boot`),
  recorded on the audit row as `metadata.context` — including on refusals, so a probe is traceable. It is
  never encrypted, so it must not hold the plaintext or a secret; a value longer than 200 characters or
  with control characters is refused. `DecryptInput`/`RewrapInput`/`DataKeyInput` gained the field, and
  `crypto:decrypt` gained `--context`.
  
  `configCrypto` sends the entry path (`config:<app>:<environment>:<label>:<key>`) as the context, so the
  crypto audit of a server-held config secret says which entry was opened.

### Patch Changes

- Updated dependencies [[`ab8292a`](https://github.com/DavideCarvalho/adonis-agora-crypto/commit/ab8292a52527a7408d5c4ab36043b0325139b86f)]:
  - @adonis-agora/crypto-core@0.2.0
  - @adonis-agora/crypto-client@0.2.1
