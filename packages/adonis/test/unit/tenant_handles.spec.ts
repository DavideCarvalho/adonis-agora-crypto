import { mkdtemp, rm } from 'node:fs/promises';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { IgnitorFactory } from '@adonisjs/core/factories';
import type { ApplicationService } from '@adonisjs/core/types';
import { describe, expect, it } from 'vitest';
import { defineConfig } from '../../src/define_config.js';
import { CryptoApi } from '../../src/http/api.js';
import { memoryCrypto } from '../../src/testing/index.js';
import { sharedSecretVerifier } from '../../src/topology/verify.js';
import { createCryptoRpc } from '../../src/transports/rpc.js';
import { addressOf, type Handler, serve } from '../http_harness.js';

/**
 * §12: a crypto tenant (HTTP or a broker transport) keeps nothing open in a plain ace process: it
 * boots, makes its one bounded `whoami` check, terminates, and leaves no timer or socket behind.
 */

type Route = { method: string; pattern: string; handler: Handler };

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

/** Timers and sockets alive right now (what would keep a process from exiting). */
function liveHandles(): string[] {
  return process
    .getActiveResourcesInfo()
    .filter((kind) => kind === 'Timeout' || kind === 'TCPSocketWrap' || kind === 'TCPWrap')
    .sort();
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

async function bootTenant(tenant: Record<string, unknown>) {
  const root = await mkdtemp(join(tmpdir(), 'crypto-tenant-handles-'));
  const ignitor = new IgnitorFactory()
    .withCoreProviders()
    .withCoreConfig()
    .merge({
      config: { crypto: defineConfig({ topology: 'tenant', tenant: tenant as never }) },
      rcFileContents: { providers: [() => import('../../providers/crypto_provider.js')] },
    })
    .create(pathToFileURL(`${root}/`));
  const app = ignitor.createApp('console') as ApplicationService;
  await app.init();
  await app.boot();
  await app.start(() => {});
  const runtime = (await app.container.make('agora.crypto')) as {
    status(): { lastCheckAt?: string };
  };
  return {
    runtime,
    terminate: async () => {
      await app.terminate();
      await rm(root, { recursive: true, force: true });
    },
  };
}

describe('a tenant in an ace process', () => {
  it('over HTTP: boots, checks once, terminates, and leaves nothing open', async () => {
    const crypto = memoryCrypto();
    const api = new CryptoApi({
      service: crypto.service,
      verifyTenant: sharedSecretVerifier({ partitions: { shop: 'shop-secret' } }),
    });
    const routes: Route[] = [];
    api.register(router(routes));
    const server: Server = await serve(routes);
    await settle();
    const before = liveHandles();

    const tenant = await bootTenant({
      url: `${addressOf(server)}/_crypto`,
      partition: 'shop',
      token: 'shop-secret',
    });
    expect(tenant.runtime.status().lastCheckAt).toBeTypeOf('string');
    await tenant.terminate();
    // The test's own server goes away; whatever is left over would be the lib's.
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await settle();
    const after = liveHandles();
    for (const kind of new Set(after)) {
      expect(after.filter((k) => k === kind).length).toBeLessThanOrEqual(
        before.filter((k) => k === kind).length,
      );
    }
  });

  it('over a broker transport: no consumer, no timer after termination', async () => {
    const crypto = memoryCrypto();
    const rpc = createCryptoRpc({
      service: crypto.service,
      verifyTenant: sharedSecretVerifier({ partitions: { shop: 'shop-secret' } }),
    });
    let calls = 0;
    // A broker driver that answers in process (through the real broker transport and its
    // timeouts): what the tenant opens is what this test measures.
    const transport = {
      name: 'memory',
      request: async (message: unknown) => {
        calls += 1;
        return rpc.handle(message);
      },
      serve: async () => async () => {},
    };
    await settle();
    const before = liveHandles();
    const tenant = await bootTenant({
      url: 'http://unused.test/_crypto',
      partition: 'shop',
      token: 'shop-secret',
      transport,
    });
    expect(calls).toBeGreaterThanOrEqual(1);
    await tenant.terminate();
    await settle();
    const after = liveHandles();
    expect(after.length).toBeLessThanOrEqual(before.length);
  });
});
