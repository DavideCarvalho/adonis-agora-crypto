import { bullmqTransport } from './bullmq.js';
import { durableTransport } from './durable.js';
import { httpTransport } from './http.js';
import { queueTransport } from './queue.js';
import { redisTransport } from './redis.js';

/**
 * How a tenant reaches the control plane. `http` is the default and needs no configuration.
 *
 * | driver | call | peer |
 * | --- | --- | --- |
 * | `http({ url })` (default) | ✅ request/response | none (global fetch) |
 * | `redis({ connection })` | ✅ lists + reply key | `@adonisjs/redis` |
 * | `bullmq({ connection })` | ✅ `job.waitUntilFinished` (native reply) | `bullmq` |
 * | `queue({ connection, dispatch, consume })` | ⚠️ reply on Redis (`@adonisjs/queue` has no await-result) | `@adonisjs/queue` |
 * | `durable({ engine })` / `durable({ gateway })` | ✅ `start('crypto.call', …)` awaits the run result | `@adonis-agora/durable` (injected) |
 *
 * Every driver carries the same envelope and the same server-side handler; only the substrate
 * changes. A broker driver (`http` is already a transport) is wrapped by `brokerTransport` for
 * `tenant.transport` — `defineConfig` accepts either form.
 */
export const transports = {
  http: httpTransport,
  redis: redisTransport,
  bullmq: bullmqTransport,
  queue: queueTransport,
  durable: durableTransport,
} as const;

export type Transports = typeof transports;
export { type BrokerDriver, brokerTransport, serveBroker } from './broker.js';
export { type BullmqTransportOptions, bullmqTransport } from './bullmq.js';
export { type HandleTransportCallOptions, handleTransportCall } from './call.js';
export {
  type DurableEngineLike,
  type DurableGatewayLike,
  type DurableRunResult,
  type DurableStarter,
  type DurableTransportOptions,
  durableTransport,
} from './durable.js';
export { type HttpTransportOptions, httpTransport } from './http.js';
export { type QueueTransportOptions, queueTransport } from './queue.js';
export {
  type RedisLike,
  type RedisTransportOptions,
  redisDeadLetter,
  redisTransport,
} from './redis.js';
export { type CryptoRpc, type CryptoRpcOptions, createCryptoRpc } from './rpc.js';
