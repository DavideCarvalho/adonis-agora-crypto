---
'@adonis-agora/crypto': minor
---

BullMQ and queue drivers for the call channel.

`transports.bullmq({ connection, queueName?, prefix?, timeoutMs? })` uses BullMQ's own reply
(`Queue.add()` + `job.waitUntilFinished(queueEvents)` resolves with the worker's return value), so the
reply is the job result and a failed job is the dead-letter; bullmq is loaded lazily and
`queue`/`queueEvents`/`worker` are injectable for tests.

`transports.queue({ connection, dispatch, consume })` carries the request on `@adonisjs/queue` and the
reply on the queue adapter's Redis (`<prefix>:reply:<id>`) because the Adonis queue has no
await-result API; the app supplies its job's `dispatch` and its worker's consumer.

Same envelope, token, dedupe, limits and dead-letter as the other drivers, and the same mixed-fleet
rule: the browser always talks HTTP and the HTTP API stays mounted.
