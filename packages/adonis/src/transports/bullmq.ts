import {
  type TransportCallMessage,
  TransportError,
  type TransportReplyMessage,
} from '@adonis-agora/crypto-core';
import { describeStackUse, redisConnectionName, redisUse } from '../stack.js';
import type { BrokerDriver } from './broker.js';

/** The slice of BullMQ a call channel needs; the real classes are imported lazily. */
export interface BullQueueLike {
  add(name: string, data: unknown, options?: Record<string, unknown>): Promise<BullJobLike>;
  close?(): Promise<void>;
}
export interface BullJobLike {
  id?: string | null;
  /** BullMQ's native reply: resolves with the worker's return value. */
  waitUntilFinished(events: unknown, ttl?: number): Promise<unknown>;
}
export interface BullQueueEventsLike {
  close?(): Promise<void>;
}
export interface BullWorkerLike {
  close?(): Promise<void>;
  waitUntilReady?(): Promise<unknown>;
}

export interface BullmqTransportOptions {
  /** The ioredis connection (or its options) bullmq shares. */
  connection: unknown;
  /** Queue name. Default `crypto-calls`. */
  queueName?: string;
  /** BullMQ key prefix. Default `crypto`. */
  prefix?: string;
  /** How long `call` waits. Default 10s. */
  timeoutMs?: number;
  /** Injected for tests / pre-built instances; omitted → lazily imports `bullmq`. */
  queue?: BullQueueLike;
  queueEvents?: BullQueueEventsLike;
  worker?: (
    name: string,
    processor: (job: { data: unknown; id?: string | null }) => Promise<unknown>,
  ) => BullWorkerLike | Promise<BullWorkerLike>;
}

/** The worker's return value is the reply, so a failed job is the dead-letter (bullmq keeps it). */
export function bullmqTransport(options: BullmqTransportOptions): BrokerDriver {
  // An `@adonisjs/redis` connection names itself; a bare client says nothing truthful.
  return describeStackUse(buildBullmqTransport(options), () => {
    const name = redisConnectionName(options.connection);
    return name ? redisUse(name, 'tenant link') : undefined;
  });
}

function buildBullmqTransport(options: BullmqTransportOptions): BrokerDriver {
  const queueName = options.queueName ?? 'crypto-calls';
  const prefix = options.prefix ?? 'crypto';
  const timeoutMs = options.timeoutMs ?? 10_000;
  let queue = options.queue;
  let events = options.queueEvents;

  const ensure = async () => {
    if (queue && !events) {
      // An injected queue brings its own wait mechanism in tests; bullmq needs QueueEvents only when
      // the driver creates the queue itself.
      events = {};
    }
    if (!queue || !events) {
      // Lazy peer: bullmq is only loaded when this driver is actually selected.
      const bullmq = (await import(/* @vite-ignore */ ['bull', 'mq'].join(''))) as unknown as {
        Queue: new (name: string, opts: Record<string, unknown>) => BullQueueLike;
        QueueEvents: new (name: string, opts: Record<string, unknown>) => BullQueueEventsLike;
      };
      queue = new bullmq.Queue(queueName, { connection: options.connection, prefix });
      events = new bullmq.QueueEvents(queueName, { connection: options.connection, prefix });
    }
    return { queue: queue!, events: events! };
  };

  return {
    name: 'bullmq',
    async request(message: TransportCallMessage, timeout: number): Promise<TransportReplyMessage> {
      const { queue: q, events: e } = await ensure();
      const budget = timeout > 0 ? timeout : timeoutMs;
      let job: BullJobLike;
      try {
        job = await q.add('call', message, {
          attempts: 1,
          removeOnComplete: { age: 300, count: 1000 },
          removeOnFail: { age: 3600, count: 1000 },
        });
      } catch (error) {
        throw new TransportError('unavailable', (error as Error).message);
      }
      let reply: unknown;
      try {
        reply = await job.waitUntilFinished(e, budget);
      } catch (error) {
        throw new TransportError(
          'timeout',
          `no reply within ${budget}ms (${(error as Error).message})`,
        );
      }
      if (typeof reply !== 'object' || reply === null) {
        throw new TransportError('malformed', 'the job finished without a reply');
      }
      return reply as TransportReplyMessage;
    },

    async serve(handler, serve = {}) {
      const processor = async (job: { data: unknown; id?: string | null }) => {
        if (typeof job.data === 'object' && job.data !== null) {
          const maybe = job.data as { id?: unknown };
          if (typeof maybe.id !== 'string') {
            await serve.deadLetter?.(job.data, 'malformed');
            throw new Error('crypto: malformed transport message');
          }
        }
        const reply = await handler(job.data);
        if (reply === null) {
          await serve.deadLetter?.(job.data, 'poison');
          throw new Error('crypto: poison transport message');
        }
        return reply;
      };
      const worker = options.worker
        ? await options.worker(queueName, processor)
        : await (async () => {
            const bullmq = (await import(
              /* @vite-ignore */ ['bull', 'mq'].join('')
            )) as unknown as {
              Worker: new (
                name: string,
                processor: (job: { data: unknown }) => Promise<unknown>,
                opts: Record<string, unknown>,
              ) => BullWorkerLike;
            };
            return new bullmq.Worker(queueName, processor as never, {
              connection: options.connection,
              prefix,
            });
          })();
      await worker.waitUntilReady?.();
      return async () => {
        await worker.close?.();
        await events?.close?.();
        await queue?.close?.();
      };
    },
  };
}
