import type { Server } from 'node:http';
import { createCryptoClient } from '@adonis-agora/crypto-core';
import { afterEach, describe, expect, it } from 'vitest';
import { CryptoService } from '../../src/crypto/service.js';
import { CryptoApi } from '../../src/http/api.js';
import { transportOperations } from '../../src/operations.js';
import { memoryCrypto, testKeyring } from '../../src/testing/index.js';
import { brokerTransport, serveBroker } from '../../src/transports/broker.js';
import { type RedisLike, redisTransport } from '../../src/transports/redis.js';
import { createCryptoRpc } from '../../src/transports/rpc.js';
import { addressOf, type Handler, serve } from '../http_harness.js';

/**
 * Sealing for another partition: a console (the Hub, a crypto tenant) encrypts with an app's
 * `console-*` key so only that app opens it. Encrypt only, with an explicit `crypto:seal:<key>`.
 */

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

/** The list commands of ioredis a call channel uses, with a blocking `brpop`. */
function memoryRedis(): RedisLike {
  const lists = new Map<string, string[]>();
  return {
    async lpush(key, value) {
      const list = lists.get(key) ?? [];
      list.unshift(value);
      lists.set(key, list);
      return list.length;
    },
    async brpop(keys, timeoutSeconds) {
      const deadline = Date.now() + timeoutSeconds * 1000;
      for (;;) {
        for (const key of keys) {
          const list = lists.get(key);
          if (list && list.length > 0) return [key, list.pop()!];
        }
        if (Date.now() >= deadline) return null;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    },
    async del(key) {
      lists.delete(key);
      return 1;
    },
  };
}

const tokens: Record<string, { partition: string; capabilities: string[]; clientId?: string }> = {
  // The Hub: a crypto tenant that may seal console commands for any app.
  'hub-token': { partition: 'hub', capabilities: ['crypto:seal:console-*'], clientId: 'hub' },
  // A sealer for any key (still never creates a non-console key).
  'sealer-token': { partition: 'hub', capabilities: ['crypto:seal:*'], clientId: 'sealer' },
  // A tenant with everything over its own partition: `crypto:*` must not let it seal elsewhere.
  'greedy-token': { partition: 'greedy', capabilities: ['crypto:*'] },
  // The app: decrypts console commands in its own partition.
  'shop-token': { partition: 'shop', capabilities: ['crypto:decrypt:console-*'] },
  // Apps with no capability at all: they still open their own console keys (implicit).
  'bare-shop-token': { partition: 'shop', capabilities: [] },
  'bare-billing-token': { partition: 'billing', capabilities: [] },
};
const verifyTenant = async (request: { token?: string }) => tokens[request.token ?? ''] ?? null;

async function server(options: { sealProvisioning?: boolean } = {}) {
  const base = memoryCrypto({ partition: 'shop' });
  const crypto =
    options.sealProvisioning === undefined
      ? base
      : {
          ...base,
          service: new CryptoService({
            store: base.store,
            keyring: testKeyring({ appKey: 'test-key-for-agora-crypto-key-material' }),
            sealProvisioning: options.sealProvisioning,
          }),
        };
  await crypto.service.createKey(crypto.principal, { name: 'console-flags', type: 'aes256-gcm' });
  await crypto.service.createKey(crypto.principal, { name: 'orders', type: 'aes256-gcm' });
  const api = new CryptoApi({ service: crypto.service, verifyTenant });
  const routes: Route[] = [];
  api.register(router(routes));
  const http = await serve(routes);
  servers.push(http);
  return { crypto, url: `${addressOf(http)}/_crypto` };
}

const shopAudit = async (crypto: ReturnType<typeof memoryCrypto>) =>
  (await crypto.service.audit(crypto.principal, { page: 1, size: 50 })).data;

describe('encrypt for another partition (crypto:seal)', () => {
  it('over HTTP: the Hub seals with the app key, only the app opens it, audited in the app', async () => {
    const { crypto, url } = await server();
    const hub = createCryptoClient({ url, partition: 'hub', token: 'hub-token', retries: 0 });
    const sealed = await hub.encrypt({
      key: 'console-flags',
      plaintext: 'rotate orders',
      aad: 'cmd-1',
      partition: 'shop',
    });
    expect(sealed).toMatchObject({ key: 'console-flags', partition: 'shop' });
    const shop = createCryptoClient({ url, partition: 'shop', token: 'shop-token', retries: 0 });
    expect(
      await shop.decrypt({ key: 'console-flags', ciphertext: sealed.ciphertext, aad: 'cmd-1' }),
    ).toMatchObject({ plaintext: 'rotate orders' });
    const row = (await shopAudit(crypto)).find(
      (entry) => entry.operation === 'encrypt' && entry.actor === 'hub',
    );
    expect(row).toMatchObject({
      partition: 'shop',
      key: 'console-flags',
      result: 'ok',
      clientId: 'hub',
      metadata: { sealedFrom: 'hub' },
    });
  });

  it('never decrypts across partitions, and needs the explicit seal grant', async () => {
    const { url } = await server();
    const hub = createCryptoClient({ url, partition: 'hub', token: 'hub-token', retries: 0 });
    const sealed = await hub.encrypt({ key: 'console-flags', plaintext: 'x', partition: 'shop' });
    // Decrypt (and every other operation) refuses a partition other than the token's.
    const raw = await fetch(`${url}/v1/decrypt`, {
      method: 'POST',
      headers: { authorization: 'Bearer hub-token', 'content-type': 'application/json' },
      body: JSON.stringify({
        key: 'console-flags',
        ciphertext: sealed.ciphertext,
        partition: 'shop',
      }),
    });
    expect(raw.status).toBe(403);
    expect(((await raw.json()) as { error: string }).error).toMatch(/never crosses partitions/);
    // The seal grant covers only its keys.
    await expect(
      hub.encrypt({ key: 'orders', plaintext: 'x', partition: 'shop' }),
    ).rejects.toMatchObject({ status: 403, message: expect.stringMatching(/crypto:seal:orders/) });
    // `crypto:*` over its own partition is not a seal grant.
    const greedy = createCryptoClient({
      url,
      partition: 'greedy',
      token: 'greedy-token',
      retries: 0,
    });
    await expect(
      greedy.encrypt({ key: 'console-flags', plaintext: 'x', partition: 'shop' }),
    ).rejects.toMatchObject({ status: 403 });
    // A missing key that is not a console key says what to create.
    const sealer = createCryptoClient({ url, partition: 'hub', token: 'sealer-token', retries: 0 });
    await expect(
      sealer.encrypt({ key: 'reports', plaintext: 'x', partition: 'shop' }),
    ).rejects.toMatchObject({
      status: 404,
      message: expect.stringMatching(/crypto:keys:create reports .*--application shop/),
    });
  });

  it('over the broker transport, the same', async () => {
    const { crypto } = await server();
    const redis = memoryRedis();
    const stop = await serveBroker(
      redisTransport({ connection: redis, timeoutMs: 2000 }),
      createCryptoRpc({ service: crypto.service, verifyTenant }),
    );
    const transport = brokerTransport(redisTransport({ connection: redis, timeoutMs: 2000 }), 2000);
    const hub = transportOperations(transport, 'hub-token');
    const sealed = await hub.encrypt({
      key: 'console-flags',
      plaintext: 'via broker',
      partition: 'shop',
    });
    expect(sealed.partition).toBe('shop');
    const shop = transportOperations(transport, 'shop-token');
    expect(
      await shop.decrypt({ key: 'console-flags', ciphertext: sealed.ciphertext }),
    ).toMatchObject({ plaintext: 'via broker' });
    await stop();
  });

  it('provisions a missing console key on the first seal (HTTP): the app then opens it', async () => {
    const { crypto, url } = await server();
    const hub = createCryptoClient({ url, partition: 'hub', token: 'hub-token', retries: 0 });
    const sealed = await hub.encrypt({ key: 'console-media', plaintext: 'cmd', partition: 'shop' });
    expect(Object.keys(sealed).sort()).toEqual(['ciphertext', 'key', 'partition', 'version']);
    expect(await crypto.store.getKey('shop', 'console-media')).toMatchObject({
      type: 'aes256-gcm',
      createdBy: 'hub',
    });
    const shop = createCryptoClient({ url, partition: 'shop', token: 'shop-token', retries: 0 });
    expect(
      await shop.decrypt({ key: 'console-media', ciphertext: sealed.ciphertext }),
    ).toMatchObject({
      plaintext: 'cmd',
    });
    const created = (await shopAudit(crypto)).find(
      (row) => row.operation === 'create' && row.key === 'console-media',
    );
    expect(created).toMatchObject({
      partition: 'shop',
      actor: 'hub',
      clientId: 'hub',
      result: 'ok',
      metadata: { provisionedBy: 'seal', sealedFrom: 'hub' },
    });
  });

  it('provisions over the broker transport and in process too', async () => {
    const { crypto } = await server();
    const redis = memoryRedis();
    const stop = await serveBroker(
      redisTransport({ connection: redis, timeoutMs: 2000 }),
      createCryptoRpc({ service: crypto.service, verifyTenant }),
    );
    const transport = brokerTransport(redisTransport({ connection: redis, timeoutMs: 2000 }), 2000);
    const sealed = await transportOperations(transport, 'hub-token').encrypt({
      key: 'console-config',
      plaintext: 'broker',
      partition: 'shop',
    });
    expect(
      await transportOperations(transport, 'shop-token').decrypt({
        key: 'console-config',
        ciphertext: sealed.ciphertext,
      }),
    ).toMatchObject({ plaintext: 'broker' });
    await stop();
    // In process, with the caller's own principal.
    const inProcess = await crypto.service.encrypt(
      { partition: 'hub', capabilities: ['crypto:seal:console-*'], actor: 'hub' },
      { key: 'console-durable', plaintext: 'local', partition: 'shop' },
    );
    expect(inProcess.partition).toBe('shop');
    expect(await crypto.store.getKey('shop', 'console-durable')).toMatchObject({
      type: 'aes256-gcm',
    });
  });

  it('decrypt never creates, and concurrent seals create one key', async () => {
    const { crypto, url } = await server();
    const shop = createCryptoClient({ url, partition: 'shop', token: 'shop-token', retries: 0 });
    await expect(
      shop.decrypt({ key: 'console-agent', ciphertext: 'agora:ct1:console-agent:1:AAAA' }),
    ).rejects.toMatchObject({ status: 404 });
    expect(await crypto.store.getKey('shop', 'console-agent')).toBeNull();

    const sealers = Array.from({ length: 8 }, () =>
      crypto.service.encrypt(
        { partition: 'hub', capabilities: ['crypto:seal:console-*'], actor: 'hub' },
        { key: 'console-agent', plaintext: 'x', partition: 'shop' },
      ),
    );
    const results = await Promise.all(sealers);
    expect(results.every((r) => r.version === 1)).toBe(true);
    expect(await crypto.store.versions('shop', 'console-agent')).toHaveLength(1);
    const creates = (await shopAudit(crypto)).filter(
      (row) => row.operation === 'create' && row.key === 'console-agent' && row.result === 'ok',
    );
    expect(creates).toHaveLength(1);
  });

  it('sealProvisioning: false answers 404 with the create command', async () => {
    const { url } = await server({ sealProvisioning: false });
    const hub = createCryptoClient({ url, partition: 'hub', token: 'hub-token', retries: 0 });
    await expect(
      hub.encrypt({ key: 'console-media', plaintext: 'x', partition: 'shop' }),
    ).rejects.toMatchObject({
      status: 404,
      message: expect.stringMatching(
        /crypto:keys:create console-media --type aes256-gcm --application shop/,
      ),
    });
  });

  it('an app opens its own console keys with no grant, and nothing else', async () => {
    const { crypto, url } = await server();
    const hub = createCryptoClient({ url, partition: 'hub', token: 'hub-token', retries: 0 });
    const sealed = await hub.encrypt({ key: 'console-flags', plaintext: 'cmd', partition: 'shop' });
    const bare = createCryptoClient({
      url,
      partition: 'shop',
      token: 'bare-shop-token',
      retries: 0,
    });
    // Implicit: decrypt with a `console-*` key in its own partition.
    expect(
      await bare.decrypt({ key: 'console-flags', ciphertext: sealed.ciphertext }),
    ).toMatchObject({ plaintext: 'cmd' });
    // Never encrypt with it, never another key.
    await expect(bare.encrypt({ key: 'console-flags', plaintext: 'forged' })).rejects.toMatchObject(
      { status: 403 },
    );
    const orders = await crypto.service.encrypt(crypto.principal, {
      key: 'orders',
      plaintext: 'x',
    });
    await expect(
      bare.decrypt({ key: 'orders', ciphertext: orders.ciphertext }),
    ).rejects.toMatchObject({
      status: 403,
      message: expect.stringMatching(/crypto:decrypt:orders/),
    });
    // Never another partition's: billing names shop (refused), or its own (no such key there).
    const billing = createCryptoClient({
      url,
      partition: 'billing',
      token: 'bare-billing-token',
      retries: 0,
    });
    const raw = await fetch(`${url}/v1/decrypt`, {
      method: 'POST',
      headers: { authorization: 'Bearer bare-billing-token', 'content-type': 'application/json' },
      body: JSON.stringify({
        key: 'console-flags',
        ciphertext: sealed.ciphertext,
        partition: 'shop',
      }),
    });
    expect(raw.status).toBe(403);
    await expect(
      billing.decrypt({ key: 'console-flags', ciphertext: sealed.ciphertext }),
    ).rejects.toMatchObject({ status: 404 });
    // Nor does it manage the key.
    const policy = await fetch(`${url}/v1/keys/console-flags`, {
      method: 'DELETE',
      headers: { authorization: 'Bearer bare-shop-token' },
    });
    expect(policy.status).toBe(403);
  });

  it('hasKey: own partition, decrypt authorization, false when missing, never audited', async () => {
    const { crypto, url } = await server();
    const before = (await shopAudit(crypto)).length;
    // In process.
    const bare = { partition: 'shop', capabilities: [] as string[], actor: 'app' };
    expect(await crypto.service.hasKey(bare, { key: 'console-flags' })).toEqual({
      key: 'console-flags',
      exists: true,
    });
    expect(await crypto.service.hasKey(bare, { key: 'console-missing' })).toMatchObject({
      exists: false,
    });
    // A non-console key needs the decrypt grant, like decrypt.
    await expect(crypto.service.hasKey(bare, { key: 'orders' })).rejects.toMatchObject({
      code: 'forbidden',
    });
    expect(
      await crypto.service.hasKey(
        { ...bare, capabilities: ['crypto:decrypt:orders'] },
        { key: 'orders' },
      ),
    ).toMatchObject({ exists: true });
    // Never another partition's.
    await expect(
      crypto.service.hasKey(bare, { key: 'console-flags', partition: 'hub' } as never),
    ).rejects.toMatchObject({ code: 'forbidden' });
    // Over HTTP (the typed client) and the broker transport: a boolean.
    const shop = createCryptoClient({
      url,
      partition: 'shop',
      token: 'bare-shop-token',
      retries: 0,
    });
    expect(await shop.hasKey({ key: 'console-flags' })).toBe(true);
    expect(await shop.hasKey({ key: 'console-nope' })).toBe(false);
    const billing = createCryptoClient({
      url,
      partition: 'billing',
      token: 'bare-billing-token',
      retries: 0,
    });
    expect(await billing.hasKey({ key: 'console-flags' })).toBe(false);
    const redis = memoryRedis();
    const stop = await serveBroker(
      redisTransport({ connection: redis, timeoutMs: 2000 }),
      createCryptoRpc({ service: crypto.service, verifyTenant }),
    );
    const transport = brokerTransport(redisTransport({ connection: redis, timeoutMs: 2000 }), 2000);
    const ops = transportOperations(transport, 'bare-shop-token');
    expect(await ops.hasKey({ key: 'console-flags' })).toBe(true);
    expect(await ops.hasKey({ key: 'console-nope' })).toBe(false);
    await stop();
    // Nothing of it reached the audit trail.
    expect((await shopAudit(crypto)).length).toBe(before);
  });

  it('a server that predates the field is reported clearly, not trusted', async () => {
    // An old server ignores `partition` and seals in the caller's own: no echo.
    const old = createCryptoClient({
      url: 'http://crypto.test/_crypto',
      partition: 'hub',
      token: 'hub-token',
      retries: 0,
      fetch: async () =>
        new Response(
          JSON.stringify({ key: 'console-flags', version: 1, ciphertext: 'agora:ct1:x' }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        ),
    });
    await expect(
      old.encrypt({ key: 'console-flags', plaintext: 'x', partition: 'shop' }),
    ).rejects.toThrow(/predates sealing for another partition.*upgrade @adonis-agora\/crypto/);
  });
});
