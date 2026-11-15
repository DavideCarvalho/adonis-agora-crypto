import { bullmqTransport } from './bullmq.js';
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
 *
 * `durable` is the documented next driver: its transport is task dispatch to workers, so a call
 * needs the control plane to run a durable worker for the crypto handler.
 */
export const transports = {
  http: httpTransport,
  redis: redisTransport,
  bullmq: bullmqTransport,
  queue: queueTransport,
} as const;

export type Transports = typeof transports;
export { type BrokerDriver, brokerTransport, serveBroker } from './broker.js';
export { type HttpTransportOptions, httpTransport } from './http.js';
export {
  type RedisLike,
  type RedisTransportOptions,
  redisDeadLetter,
  redisTransport,
} from './redis.js';
export { type CryptoRpc, type CryptoRpcOptions, createCryptoRpc } from './rpc.js';
