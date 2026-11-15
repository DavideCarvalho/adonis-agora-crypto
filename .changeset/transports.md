---
'@adonis-agora/crypto': minor
'@adonis-agora/crypto-core': minor
---

Pluggable tenant ↔ control-plane transports for the call channel.

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
