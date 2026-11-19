import {
  type TransportCallMessage,
  TransportError,
  type TransportReplyMessage,
} from '@adonis-agora/crypto-core';
import { describeStackUse, redisConnectionName, redisUse } from '../stack.js';
import type { BrokerDriver } from './broker.js';
import type { RedisLike } from './redis.js';

export interface QueueTransportOptions {
  /** The queue adapter's Redis connection (the reply travels on it; @adonisjs/queue has no await-result). */
  connection: RedisLike;
  /** How the app enqueues the call job (its `@adonisjs/queue` job's `dispatch`). */
  dispatch: (payload: TransportCallMessage) => Promise<unknown>;
  /**
   * The app's own queue consumer: registers `onMessage` on its worker and returns a stop function.
   * `@adonisjs/queue` owns the worker loop (job classes, retries, `locations`), so the driver cannot
   * start it — it plugs into it.
   */
  consume: (onMessage: (payload: unknown) => Promise<void>) => Promise<() => Promise<void>>;
  /** Key prefix for the reply/list keys. Default `crypto`. */
  prefix?: string;
  /** How long `call` waits for the reply. Default 10s. */
  timeoutMs?: number;
}

/**
 * `transports.queue({ connection, dispatch })` — the request rides `@adonisjs/queue`, the reply
 * comes back on Redis.
 *
 * `@boringnode/queue`'s `dispatch` resolves `{ jobId }` and has no "wait for the result", so unlike
 * BullMQ (which has `job.waitUntilFinished`) a queue call needs a reply channel: the control plane
 * pushes `<prefix>:reply:<id>` and the tenant blocks on it — the same reply contract the Redis driver
 * uses. The app supplies its own job class' dispatch, so the job is just a transport for the
 * envelope.
 */
export function queueTransport(options: QueueTransportOptions): BrokerDriver {
  // An `@adonisjs/redis` connection names itself; a bare client says nothing truthful.
  return describeStackUse(buildQueueTransport(options), () => {
    const name = redisConnectionName(options.connection);
    return name ? redisUse(name, 'tenant link') : undefined;
  });
}

function buildQueueTransport(options: QueueTransportOptions): BrokerDriver {
  const prefix = options.prefix ?? 'crypto';
  const timeoutMs = options.timeoutMs ?? 10_000;
  const replyKey = (id: string) => `${prefix}:reply:${id}`;
  const deadKey = `${prefix}:dead`;

  return {
    name: 'queue',
    async request(message: TransportCallMessage, timeout: number): Promise<TransportReplyMessage> {
      const budget = timeout > 0 ? timeout : timeoutMs;
      await options.dispatch(message);
      const cutoff = Date.now() + budget;
      while (Date.now() < cutoff) {
        const seconds = Math.max(1, Math.ceil((cutoff - Date.now()) / 1000));
        const popped = await options.connection.brpop([replyKey(message.id)], seconds);
        if (popped === null) continue;
        await options.connection.del?.(replyKey(message.id));
        try {
          return JSON.parse(popped[1]) as TransportReplyMessage;
        } catch {
          throw new TransportError('malformed', 'the reply is not JSON');
        }
      }
      throw new TransportError('timeout', `no reply within ${budget}ms`);
    },

    /** The control plane side: registers the consumer on the app's queue worker. */
    async serve(handler, serve = {}) {
      return options.consume(async (payload) => {
        const reply = await handler(payload);
        if (reply === null) {
          await serve.deadLetter?.(payload, 'poison');
          await options.connection.lpush(deadKey, JSON.stringify({ reason: 'poison', payload }));
          return;
        }
        await options.connection.lpush(replyKey(reply.id), JSON.stringify(reply));
      });
    },
  };
}
