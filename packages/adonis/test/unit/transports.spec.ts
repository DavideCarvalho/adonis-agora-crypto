import type { Server } from 'node:http';
import {
  assertTransportSize,
  createDedupe,
  TRANSPORT_MESSAGE_VERSION,
  type TransportCallMessage,
  TransportError,
} from '@adonis-agora/crypto-core';
import { afterEach, describe, expect, it } from 'vitest';
import { CryptoApi } from '../../src/http/api.js';
import { memoryCrypto } from '../../src/testing/index.js';
import { brokerTransport, serveBroker } from '../../src/transports/broker.js';
import { httpTransport } from '../../src/transports/http.js';
import { type RedisLike, redisTransport } from '../../src/transports/redis.js';
import { createCryptoRpc } from '../../src/transports/rpc.js';
import { addressOf, type Handler, serve } from '../http_harness.js';

interface Route {
  method: string;
  pattern: string;
  handler: Handler;
}
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

function router(routes: Route[]) {
  const register = (method: string) => (pattern: string, handler: Handler) => {
    routes.push({ method, pattern, handler });
    return { as: () => {} };
  };
  return {
    get: register('GET'),
    post: register('POST'),
    patch: register('PATCH'),
    delete: register('DELETE'),
  };
}

/** The slice of ioredis a call channel uses, with blocking `brpop` like the real thing. */
function memoryRedis(): RedisLike & { lists: Map<string, string[]>; waiters: Array<() => void> } {
  const lists = new Map<string, string[]>();
  const waiters: Array<() => void> = [];
  const wake = () => {
    for (const waiter of waiters.splice(0)) waiter();
  };
  return {
    lists,
    waiters,
    async lpush(key, value) {
      const list = lists.get(key) ?? [];
      list.unshift(value);
      lists.set(key, list);
      wake();
      return list.length;
    },
    async brpop(keys, timeoutSeconds) {
      const deadline = Date.now() + timeoutSeconds * 1000;
      for (;;) {
        for (const key of keys) {
          const list = lists.get(key);
          if (list && list.length > 0) {
            const value = list.pop()!;
            if (list.length === 0) lists.delete(key);
            return [key, value];
          }
        }
        const remaining = deadline - Date.now();
        if (remaining <= 0) return null;
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, Math.min(remaining, 20));
          waiters.push(() => {
            clearTimeout(timer);
            resolve();
          });
        });
      }
    },
    async del(key) {
      lists.delete(key);
      return 1;
    },
  };
}

const tokens: Record<string, { partition: string; capabilities: string[] }> = {
  'alpha-token': { partition: 'alpha', capabilities: ['crypto:*'] },
  'beta-token': { partition: 'beta', capabilities: ['crypto:*'] },
};
const verifyTenant = async (request: { token?: string }) => tokens[request.token ?? ''] ?? null;

async function controlPlane() {
  const crypto = memoryCrypto({ partition: 'alpha' });
  await crypto.service.createKey(crypto.principal, { name: 'media', type: 'aes256-gcm' });
  await crypto.service.createKey(
    { ...crypto.principal, partition: 'beta' },
    { name: 'notes', type: 'aes256-gcm' },
  );
  const api = new CryptoApi({ service: crypto.service, verifyTenant });
  const routes: Route[] = [];
  api.register(router(routes));
  const server = await serve(routes);
  servers.push(server);
  return { crypto, url: `${addressOf(server)}/_crypto` };
}

describe('tenant transports', () => {
  it('serves a mixed fleet: one tenant on http, another on a broker, same control plane', async () => {
    const { crypto, url } = await controlPlane();
    const redis = memoryRedis();
    const stop = await serveBroker(
      redisTransport({ connection: redis, timeoutMs: 2000 }),
      createCryptoRpc({ service: crypto.service, verifyTenant }),
    );

    // The browser-facing HTTP API is mounted whatever the tenant transport is.
    const alpha = httpTransport({ url });
    const beta = brokerTransport(redisTransport({ connection: redis, timeoutMs: 2000 }), 2000);

    const alphaCipher = await alpha.call<{ ciphertext: string }>({
      operation: 'encrypt',
      input: { key: 'media', plaintext: 'from http' },
      token: 'alpha-token',
    });
    const betaCipher = await beta.call<{ ciphertext: string }>({
      operation: 'encrypt',
      input: { key: 'notes', plaintext: 'from broker' },
      token: 'beta-token',
    });

    expect(
      await alpha.call({
        operation: 'decrypt',
        input: { key: 'media', ciphertext: alphaCipher.ciphertext },
        token: 'alpha-token',
      }),
    ).toMatchObject({ plaintext: 'from http' });
    expect(
      await beta.call({
        operation: 'decrypt',
        input: { key: 'notes', ciphertext: betaCipher.ciphertext },
        token: 'beta-token',
      }),
    ).toMatchObject({ plaintext: 'from broker' });

    // Partition comes from the token on both drivers: beta cannot touch alpha's key.
    await expect(
      beta.call({
        operation: 'decrypt',
        input: { key: 'media', ciphertext: alphaCipher.ciphertext },
        token: 'beta-token',
      }),
    ).rejects.toBeInstanceOf(TransportError);
    await expect(
      alpha.call({ operation: 'keys.get', input: { name: 'notes' }, token: 'alpha-token' }),
    ).rejects.toBeInstanceOf(TransportError);

    await stop();
  });

  it('verifies the token on every message, dedupes the id and refuses stale/oversized ones', async () => {
    const { crypto } = await controlPlane();
    const redis = memoryRedis();
    const rpc = createCryptoRpc({ service: crypto.service, verifyTenant, dedupe: createDedupe() });
    const stop = await serveBroker(redisTransport({ connection: redis, timeoutMs: 2000 }), rpc);
    const beta = brokerTransport(redisTransport({ connection: redis, timeoutMs: 2000 }), 2000);

    await expect(
      beta.call({ operation: 'whoami', input: {}, token: 'not-a-token' }),
    ).rejects.toThrow(/unauthorized/);

    const message: TransportCallMessage = {
      v: TRANSPORT_MESSAGE_VERSION,
      id: 'dedupe-1',
      operation: 'whoami',
      input: {},
      token: 'beta-token',
      issuedAt: Date.now(),
    };
    const first = await rpc.handle(message);
    expect(first.ok).toBe(true);
    const second = await rpc.handle(message);
    expect(second).toMatchObject({ ok: false, error: { code: 'conflict' } });

    const stale = await rpc.handle({
      ...message,
      id: 'stale-1',
      issuedAt: Date.now() - 60 * 60 * 1000,
    });
    expect(stale).toMatchObject({ ok: false, error: { code: 'invalid' } });

    const huge = { ...message, id: 'huge-1', input: { blob: 'x'.repeat(600 * 1024) } };
    expect(rpc.isPoison(huge)).toBe(true);
    expect(() => assertTransportSize(huge)).toThrow(TransportError);

    await stop();
  });
});
