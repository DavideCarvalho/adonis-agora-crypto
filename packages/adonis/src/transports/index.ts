import { httpTransport } from './http.js';
import { redisTransport } from './redis.js';

/**
 * How a tenant reaches the control plane. `http` is the default and needs no configuration.
 *
 * | driver | call | peer |
 * | --- | --- | --- |
 * | `http({ url })` (default) | ✅ request/response | none (global fetch) |
 * | `redis({ connection })` | ✅ lists + reply key | `@adonisjs/redis` |
 *
 * `queue`, `bullmq` and `durable` are the documented next drivers: they carry the same envelope,
 * but their request/reply needs a reply channel (Redis) and the app's ready queue/worker instance,
 * so they land as `transports.broker` adapters.
 */
export const transports = {
  http: httpTransport,
  redis: redisTransport,
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
