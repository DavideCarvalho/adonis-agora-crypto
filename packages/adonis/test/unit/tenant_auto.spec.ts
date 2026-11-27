import { mkdtemp, rm } from 'node:fs/promises';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { IgnitorFactory } from '@adonisjs/core/factories';
import type { ApplicationService } from '@adonisjs/core/types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defineConfig } from '../../src/define_config.js';
import { agoraDoctorChecks } from '../../src/doctor/checks.js';
import { CryptoApi } from '../../src/http/api.js';
import type { CryptoRuntime } from '../../src/runtime.js';
import { memoryCrypto } from '../../src/testing/index.js';
import { describeTenantSources, resolveTenantFields } from '../../src/topology/tenant_auto.js';
import { sharedSecretVerifier } from '../../src/topology/verify.js';
import { addressOf, type Handler, serve } from '../http_harness.js';

/**
 * Zero-config tenant: with authkit-client's `'authkit.client'` binding (its `tenantOf`), the url,
 * token and partition are discovered; anything in config/crypto.ts wins, field by field.
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

/** A fake authkit-client binding: `tenantOf` answers lazy url/token handles and a partition. */
function fakeAuthkit(base: string, calls: string[] = []) {
  return {
    tenantOf(resource: string) {
      calls.push(resource);
      const url = Object.assign(async () => base, { refresh: async () => base });
      const token = Object.assign(async () => 'shop-secret', { reset: () => {} });
      return { url, token, partition: 'shop' };
    },
  };
}

async function boot(
  tenant: Record<string, unknown> | undefined,
  options: { authkit?: unknown; environment?: 'web' | 'console' } = {},
) {
  const root = await mkdtemp(join(tmpdir(), 'crypto-tenant-auto-'));
  const ignitor = new IgnitorFactory()
    .withCoreProviders()
    .withCoreConfig()
    .merge({
      config: {
        crypto: defineConfig({
          topology: 'tenant',
          ...(tenant ? { tenant: tenant as never } : {}),
        }),
      },
      rcFileContents: { providers: [() => import('../../providers/crypto_provider.js')] },
    })
    .create(pathToFileURL(`${root}/`));
  const app = ignitor.createApp(options.environment ?? 'console') as ApplicationService;
  await app.init();
  if (options.authkit !== undefined) {
    app.container.singleton('authkit.client' as never, async () => options.authkit as never);
  }
  const cleanup = async () => {
    await app.terminate().catch(() => {});
    await rm(root, { recursive: true, force: true });
  };
  try {
    await app.boot();
  } catch (error) {
    await cleanup();
    throw error;
  }
  const runtime = (await app.container.make('agora.crypto')) as CryptoRuntime;
  return { app, runtime, cleanup };
}

describe('tenant topology with authkit-client', () => {
  let server: Server;
  let base: string;

  beforeAll(async () => {
    const crypto = memoryCrypto();
    const api = new CryptoApi({
      service: crypto.service,
      verifyTenant: sharedSecretVerifier({ partitions: { shop: 'shop-secret' } }),
    });
    const routes: Route[] = [];
    api.register(router(routes));
    server = await serve(routes);
    base = `${addressOf(server)}/_crypto`;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  it('fills url, token and partition from tenantOf(urn:agora:crypto)', async () => {
    const calls: string[] = [];
    const { runtime, cleanup } = await boot(undefined, { authkit: fakeAuthkit(base, calls) });
    try {
      expect(calls).toEqual(['urn:agora:crypto']);
      expect(runtime.partition).toBe('shop');
      expect(runtime.tenant?.sources).toEqual({
        url: 'authkit-client (auto)',
        token: 'authkit-client (auto)',
        partition: 'authkit-client (auto)',
      });
      // The boot whoami went to the discovered server with the discovered token.
      expect(runtime.status().lastCheckAt).toBeTypeOf('string');
      expect(await runtime.client?.resolveUrl()).toBe(base);
    } finally {
      await cleanup();
    }
  });

  it('lets each explicit field win over the discovered one', async () => {
    const { runtime, cleanup } = await boot(
      { partition: 'billing', checkOnBoot: false },
      { authkit: fakeAuthkit(base) },
    );
    try {
      expect(runtime.partition).toBe('billing');
      expect(runtime.tenant?.sources).toEqual({
        url: 'authkit-client (auto)',
        token: 'authkit-client (auto)',
        partition: 'explicit',
      });
    } finally {
      await cleanup();
    }
    const explicitUrl = await resolveTenantFields(
      { hasBinding: () => true, make: async () => fakeAuthkit(base) },
      { url: 'https://crypto.example.com/_crypto', token: 'mine' },
      'urn:agora:crypto',
    );
    expect(explicitUrl.url).toBe('https://crypto.example.com/_crypto');
    expect(explicitUrl.token).toBe('mine');
    expect(explicitUrl.partition).toBe('shop');
    expect(describeTenantSources(explicitUrl.sources)).toBe(
      'tenant url: explicit, token: explicit, partition: authkit-client (auto)',
    );
  });

  it('never asks authkit-client when every field is explicit', async () => {
    const calls: string[] = [];
    const resolved = await resolveTenantFields(
      { hasBinding: () => true, make: async () => fakeAuthkit(base, calls) },
      { url: base, token: 'shop-secret', partition: 'shop' },
      'urn:agora:crypto',
    );
    expect(calls).toEqual([]);
    expect(resolved.missing).toEqual([]);
  });

  it('refuses to boot a web process without the binding, naming the fields and both fixes', async () => {
    await expect(boot(undefined, { environment: 'web' })).rejects.toThrow(
      "[@adonis-agora/crypto] topology 'tenant' needs tenant.url, tenant.token, tenant.partition. Configure @adonis-agora/authkit-client's `service` (config/authkit.ts: service: { name, clientId, clientSecret }) so they are discovered from the issuer, or pass tenant: { url, token, partition } in config/crypto.ts.",
    );
    await expect(boot({ partition: 'shop' }, { environment: 'web' })).rejects.toThrow(
      /needs tenant\.url, tenant\.token\. /,
    );
  });

  it('boots an ace process anyway and fails on the first call', async () => {
    const { runtime, cleanup } = await boot(undefined);
    try {
      expect(runtime.tenant?.missing).toEqual(['url', 'token', 'partition']);
      await expect(runtime.client?.resolveUrl()).rejects.toThrow(/needs tenant\.url/);
    } finally {
      await cleanup();
    }
  });

  it('treats an older authkit-client (no tenantOf) as absent', async () => {
    await expect(
      boot(undefined, { environment: 'web', authkit: { appCallTokens: () => undefined } }),
    ).rejects.toThrow(/needs tenant\.url, tenant\.token, tenant\.partition/);
  });

  it('surfaces why tenantOf could not answer (no `service`)', async () => {
    const authkit = {
      tenantOf() {
        throw new Error('tenantOf needs `service` in config/authkit.ts');
      },
    };
    await expect(boot(undefined, { environment: 'web', authkit })).rejects.toThrow(
      /needs tenant\.url, tenant\.token, tenant\.partition \(authkit-client: tenantOf needs `service`/,
    );
  });

  it('ignores the binding with tenant.auto: false', async () => {
    const calls: string[] = [];
    await expect(
      boot({ auto: false }, { environment: 'web', authkit: fakeAuthkit(base, calls) }),
    ).rejects.toThrow(/needs tenant\.url, tenant\.token, tenant\.partition/);
    expect(calls).toEqual([]);
  });

  it('shows where each field came from in agora:doctor', async () => {
    const check = agoraDoctorChecks.find((entry) => entry.id === 'crypto.tenant-config');
    if (!check) throw new Error('no crypto.tenant-config check');
    const { app, cleanup } = await boot(
      { partition: 'billing', checkOnBoot: false },
      { authkit: fakeAuthkit(base) },
    );
    try {
      expect(await check.run(app)).toEqual({
        status: 'ok',
        message:
          'tenant url: authkit-client (auto), token: authkit-client (auto), partition: explicit.',
      });
    } finally {
      await cleanup();
    }
    const { app: bare, cleanup: cleanupBare } = await boot(undefined);
    try {
      const result = (await check.run(bare)) as { status: string; message: string; fix: string };
      expect(result.status).toBe('error');
      expect(result.message).toBe('tenant url: missing, token: missing, partition: missing.');
      expect(result.fix).toMatch(/Configure @adonis-agora\/authkit-client's `service`/);
    } finally {
      await cleanupBare();
    }
  });
});
