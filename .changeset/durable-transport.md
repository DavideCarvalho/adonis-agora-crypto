---
'@adonis-agora/crypto': minor
---

Durable as a transport driver.

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
