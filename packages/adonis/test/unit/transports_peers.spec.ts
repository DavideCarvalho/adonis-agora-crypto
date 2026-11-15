import { TransportError, type TransportReplyMessage } from '@adonis-agora/crypto-core';
import { describe, expect, it } from 'vitest';
import { memoryCrypto } from '../../src/testing/index.js';
import {
  type BullJobLike,
  type BullQueueLike,
  bullmqTransport,
} from '../../src/transports/bullmq.js';
import { queueTransport } from '../../src/transports/queue.js';
import type { RedisLike } from '../../src/transports/redis.js';
import { createCryptoRpc } from '../../src/transports/rpc.js';

const verifyTenant = async (request: { token?: string }) =>
  request.token === 'tenant-token' ? { partition: 'shop', capabilities: ['crypto:*'] } : null;

function memoryRedis(): RedisLike {
  const lists = new Map<string, string[]>();
  return {
    async lpush(key, value) {
      const list = lists.get(key) ?? [];
      list.unshift(value);
      lists.set(key, list);
      return list.length;
    },
    async brpop(keys) {
      for (const key of keys) {
        const list = lists.get(key);
        if (list && list.length > 0) {
          const value = list.pop()!;
          if (list.length === 0) lists.delete(key);
          return [key, value];
        }
      }
      return null;
    },
    async del(key) {
      lists.delete(key);
      return 1;
    },
  };
}

/** A fake BullMQ pair: `add` stores the job, `waitUntilFinished` resolves when the worker replies. */
function fakeBullmq() {
  const pending = new Map<string, { data: unknown; resolve: (value: unknown) => void }>();
  const queue: BullQueueLike = {
    async add(_name, data) {
      const id = `job-${pending.size + 1}`;
      const job: BullJobLike = {
        id,
        waitUntilFinished: () =>
          new Promise((resolve) => {
            pending.set(id, { data, resolve });
          }),
      };
      return job;
    },
  };
  let processor: ((job: { data: unknown; id?: string }) => Promise<unknown>) | undefined;
  return {
    queue,
    worker: (_name: string, handler: typeof processor) => {
      processor = handler;
      return {};
    },
    async run() {
      // `request()` awaits `ensure()` before `add`, so wait for the job to land.
      for (let attempt = 0; attempt < 100 && pending.size === 0; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 2));
      }
      for (const [id, entry] of [...pending]) {
        pending.delete(id);
        entry.resolve(await processor!({ data: entry.data, id }));
      }
    },
  };
}

describe('bullmq driver', () => {
  it('uses the job result as the reply (native waitUntilFinished) and audits the operation', async () => {
    const crypto = memoryCrypto();
    await crypto.service.createKey(crypto.principal, { name: 'media', type: 'aes256-gcm' });
    const fake = fakeBullmq();
    const driver = bullmqTransport({
      connection: {},
      queue: fake.queue,
      worker: fake.worker as never,
    });
    const stop = await driver.serve(async (message) => {
      const rpc = createCryptoRpc({ service: crypto.service, verifyTenant });
      return rpc.handle(message);
    });

    const call = driver.request(
      {
        v: 1,
        id: 'call-1',
        operation: 'encrypt',
        input: { key: 'media', plaintext: 'via bullmq' },
        token: 'tenant-token',
        issuedAt: Date.now(),
      },
      1000,
    );
    await fake.run();
    const reply = (await call) as TransportReplyMessage;
    expect(reply).toMatchObject({ ok: true, id: 'call-1' });
    expect((reply.result as { ciphertext: string }).ciphertext).toContain('agora:ct1:media');

    const audit = await crypto.service.audit(crypto.principal, { page: 1, size: 10 });
    expect(audit.data.some((row) => row.key === 'media' && row.operation === 'encrypt')).toBe(true);
    await stop();
  });

  it('surfaces a failed job as a timeout/unavailable, never a hang', async () => {
    const driver = bullmqTransport({
      connection: {},
      queue: {
        async add() {
          throw new Error('broker down');
        },
      },
      worker: fakeBullmq().worker as never,
    });
    await expect(
      driver.request(
        {
          v: 1,
          id: 'call-2',
          operation: 'whoami',
          input: {},
          token: 'tenant-token',
          issuedAt: Date.now(),
        },
        100,
      ),
    ).rejects.toBeInstanceOf(TransportError);
  });
});

describe('queue driver (@adonisjs/queue has no await-result)', () => {
  it('sends the job through the app dispatcher and takes the reply from Redis', async () => {
    const crypto = memoryCrypto();
    await crypto.service.createKey(crypto.principal, { name: 'notes', type: 'aes256-gcm' });
    const redis = memoryRedis();
    const rpc = createCryptoRpc({ service: crypto.service, verifyTenant });
    let consumer: ((payload: unknown) => Promise<void>) | undefined;

    const driver = queueTransport({
      connection: redis,
      dispatch: async () => ({ jobId: '1' }),
      consume: async (onMessage) => {
        consumer = onMessage;
        return async () => {};
      },
    });
    const stop = await driver.serve(async (payload) => rpc.handle(payload));

    const call = driver.request(
      {
        v: 1,
        id: 'queue-1',
        operation: 'encrypt',
        input: { key: 'notes', plaintext: 'via queue' },
        token: 'tenant-token',
        issuedAt: Date.now(),
      },
      2000,
    );
    // The app's worker would call the consumer with the job payload.
    await consumer!({
      v: 1,
      id: 'queue-1',
      operation: 'encrypt',
      input: { key: 'notes', plaintext: 'via queue' },
      token: 'tenant-token',
      issuedAt: Date.now(),
    });
    const reply = (await call) as TransportReplyMessage;
    expect(reply).toMatchObject({ ok: true });
    await stop();
  });
});
