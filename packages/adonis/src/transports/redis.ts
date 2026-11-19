import {
  type TransportCallMessage,
  TransportError,
  type TransportReplyMessage,
} from '@adonis-agora/crypto-core';
import { describeStackUse, redisConnectionName, redisUse } from '../stack.js';
import type { BrokerDriver } from './broker.js';

/** The slice of `@adonisjs/redis` (ioredis) a call channel needs. */
export interface RedisLike {
  lpush(key: string, value: string): Promise<unknown>;
  brpop(keys: string[], timeoutSeconds: number): Promise<[string, string] | null>;
  del?(key: string): Promise<unknown>;
}

export interface RedisTransportOptions {
  /** The `@adonisjs/redis` connection (or any ioredis-shaped one). */
  connection: RedisLike;
  /** Key prefix. Default `crypto`. */
  prefix?: string;
  /** How long `call` waits for the reply. Default 10s. */
  timeoutMs?: number;
}

const keys = (prefix: string) => ({
  requests: `${prefix}:requests`,
  reply: (id: string) => `${prefix}:reply:${id}`,
  dead: `${prefix}:dead`,
});

/**
 * `transports.redis({ connection })` — the call channel over Redis lists.
 *
 * The tenant `LPUSH`es the message on `<prefix>:requests` and `BRPOP`s `<prefix>:reply:<id>`; the
 * control plane consumes the same list and pushes the reply on that key. No pub/sub: a reply must
 * reach exactly the caller that asked. A shared broker is not a trust boundary, so the token still
 * travels on every message and `verifyTenant` runs on each.
 */
export function redisTransport(options: RedisTransportOptions): BrokerDriver {
  // An `@adonisjs/redis` connection names itself; a bare client says nothing truthful.
  return describeStackUse(buildRedisTransport(options), () => {
    const name = redisConnectionName(options.connection);
    return name ? redisUse(name, 'tenant link') : undefined;
  });
}

function buildRedisTransport(options: RedisTransportOptions): BrokerDriver {
  const prefix = options.prefix ?? 'crypto';
  const k = keys(prefix);
  const timeoutMs = options.timeoutMs ?? 10_000;

  return {
    name: 'redis',
    async request(message: TransportCallMessage, timeout: number): Promise<TransportReplyMessage> {
      const budget = timeout > 0 ? timeout : timeoutMs;
      const replyKey = k.reply(message.id);
      await options.connection.lpush(k.requests, JSON.stringify(message));
      const cutoff = Date.now() + budget;
      while (Date.now() < cutoff) {
        const seconds = Math.max(1, Math.ceil((cutoff - Date.now()) / 1000));
        const popped = await options.connection.brpop([replyKey], seconds);
        if (popped === null) continue;
        await options.connection.del?.(replyKey);
        try {
          return JSON.parse(popped[1]) as TransportReplyMessage;
        } catch {
          throw new TransportError('malformed', 'the reply is not JSON');
        }
      }
      throw new TransportError('timeout', `no reply within ${budget}ms`);
    },

    async serve(handler, serve = {}) {
      let running = true;
      const loop = (async () => {
        while (running) {
          const popped = await options.connection.brpop([k.requests], 1);
          if (popped === null) continue;
          let message: unknown;
          try {
            message = JSON.parse(popped[1]);
          } catch {
            await serve.deadLetter?.(popped[1], 'not-json');
            continue;
          }
          try {
            const reply = await handler(message);
            if (reply !== null) {
              await options.connection.lpush(k.reply(reply.id), JSON.stringify(reply));
            } else {
              await serve.deadLetter?.(message, 'poison');
            }
          } catch (error) {
            await serve.deadLetter?.(message, (error as Error).message);
          }
        }
      })();
      return async () => {
        running = false;
        await loop;
      };
    },
  };
}

/** Convenience for the app: a dead-letter list capped by trimming is left to the deployment. */
export const redisDeadLetter =
  (connection: RedisLike, prefix = 'crypto') =>
  async (message: unknown, reason: string) => {
    await connection.lpush(keys(prefix).dead, JSON.stringify({ reason, at: Date.now(), message }));
  };
