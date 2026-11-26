import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { CryptoConsole } from '../../src/dashboard/console.js';
import { resolveDashboardConfig } from '../../src/dashboard/define_config.js';
import { memoryCrypto } from '../../src/testing/index.js';
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
  return {
    get(pattern: string, handler: Handler) {
      routes.push({ method: 'GET', pattern, handler });
      return {};
    },
    post(pattern: string, handler: Handler) {
      routes.push({ method: 'POST', pattern, handler });
      return {};
    },
    patch(pattern: string, handler: Handler) {
      routes.push({ method: 'PATCH', pattern, handler });
      return {};
    },
    delete(pattern: string, handler: Handler) {
      routes.push({ method: 'DELETE', pattern, handler });
      return {};
    },
  };
}

async function start(
  options: {
    authorize?: boolean;
    path?: string;
    grant?: '*' | string[];
    apps?: string[];
    capabilities?: string[];
  } = {},
) {
  const crypto = memoryCrypto();
  const console = new CryptoConsole({
    service: crypto.service,
    config: resolveDashboardConfig({
      ...(options.path !== undefined ? { path: options.path } : {}),
      ...(options.apps !== undefined ? { apps: options.apps } : {}),
      authorize: () =>
        options.authorize === false
          ? { allowed: false as const, status: 403 as const, reason: 'forbidden' as const }
          : {
              allowed: true as const,
              ...(options.grant !== undefined ? { apps: options.grant } : {}),
              ...(options.capabilities !== undefined ? { capabilities: options.capabilities } : {}),
            },
    }),
    spaDir: '/nowhere',
    defaultPartition: 'shop',
    inProduction: true,
    topology: 'control-plane',
    logger: { warn: () => {}, info: () => {} },
  });
  const routes: Route[] = [];
  console.register(router(routes));
  const server = await serve(routes);
  servers.push(server);
  return { base: addressOf(server), crypto, api: `${addressOf(server)}/${'_crypto'}/api` };
}

const json = (method: string, body?: unknown) => ({
  method,
  headers: { 'content-type': 'application/json' },
  ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
});

describe('console API', () => {
  it('lists apps and serves the overview of one', async () => {
    const { base, crypto } = await start();
    await crypto.service.createKey(crypto.principal, { name: 'orders', type: 'aes256-gcm' });
    const meta = await fetch(`${base}/_crypto/api/meta`);
    expect(meta.status).toBe(200);
    expect(await meta.json()).toMatchObject({
      apps: ['shop'],
      defaultPartition: 'shop',
      topology: 'control-plane',
    });

    const overview = await fetch(`${base}/_crypto/api/overview?partition=shop`);
    expect(await overview.json()).toMatchObject({ partition: 'shop', keys: 1, versions: 1 });
  });

  it('creates, rotates, policies and deletes a key through the console', async () => {
    const { base } = await start();
    const created = await fetch(`${base}/_crypto/api/keys?partition=shop`, {
      ...json('POST', { name: 'media', type: 'aes256-gcm', deletionAllowed: true }),
    });
    expect(created.status).toBe(201);
    const key = (await created.json()) as { name: string; latestVersion: number };
    expect(key).toMatchObject({ name: 'media', latestVersion: 1 });

    const rotated = await fetch(
      `${base}/_crypto/api/keys/media/rotate?partition=shop`,
      json('POST', {}),
    );
    expect(await rotated.json()).toMatchObject({ latestVersion: 2 });

    const policy = await fetch(`${base}/_crypto/api/keys/media?partition=shop`, {
      ...json('PATCH', { minDecryptionVersion: 2, exportable: true }),
    });
    expect(await policy.json()).toMatchObject({ minDecryptionVersion: 2, exportable: true });

    const list = await fetch(`${base}/_crypto/api/keys?partition=shop&page=1&size=10`);
    expect((await list.json()).meta).toMatchObject({ total: 1 });

    const deleted = await fetch(`${base}/_crypto/api/keys/media?partition=shop`, json('DELETE'));
    expect(await deleted.json()).toEqual({ key: 'media', deleted: true });
  });

  it('never exposes key material or plaintext, and has no export endpoint', async () => {
    const { base, crypto } = await start();
    await crypto.service.createKey(crypto.principal, { name: 'inbox', type: 'x25519' });
    const one = await fetch(`${base}/_crypto/api/keys/inbox?partition=shop`);
    const body = await one.text();
    expect(body).not.toMatch(/material|sealed|"d"/);
    const exportRoute = await fetch(`${base}/_crypto/api/keys/inbox/export?partition=shop`);
    expect(exportRoute.status).toBe(404);
    const audit = await fetch(`${base}/_crypto/api/audit?partition=shop`);
    expect(await audit.text()).not.toMatch(/plaintext/);
  });

  it('serves the audit trail with filters and the 24h counters', async () => {
    const { base, crypto } = await start();
    await crypto.service.createKey(crypto.principal, { name: 'orders', type: 'aes256-gcm' });
    await crypto.service.encrypt(crypto.principal, { key: 'orders', plaintext: 'x' });
    const audit = await fetch(
      `${base}/_crypto/api/audit?partition=shop&filter[operation]=encrypt&filter[result]=ok`,
    );
    const page = (await audit.json()) as { data: Array<{ operation: string; actor: string }> };
    expect(page.data).toHaveLength(1);
    expect(page.data[0]).toMatchObject({ operation: 'encrypt', actor: 'test' });

    await crypto.service.encrypt(crypto.principal, { key: 'orders', plaintext: 'y' });
    const cursor = await fetch(
      `${base}/_crypto/api/audit?partition=shop&filter[operation]=encrypt&first=1`,
    );
    const first = (await cursor.json()) as { data: unknown[]; meta: { nextCursor: string } };
    expect(first.data).toHaveLength(1);
    const after = await fetch(
      `${base}/_crypto/api/audit?partition=shop&filter[operation]=encrypt&first=1&after=${first.meta.nextCursor}`,
    );
    expect(await after.json()).toMatchObject({ meta: { hasNext: false, hasPrev: true } });
  });

  it('refuses every call when the gate says no, and audits no operation', async () => {
    const { base } = await start({ authorize: false });
    const meta = await fetch(`${base}/_crypto/api/meta`);
    expect(meta.status).toBe(403);
    expect(await meta.json()).toEqual({ error: 'forbidden' });
    const page = await fetch(`${base}/_crypto`);
    expect(page.status).toBe(403);
  });

  it('falls back to the default app when the request names none', async () => {
    const { base } = await start();
    const response = await fetch(`${base}/_crypto/api/keys`);
    expect(response.status).toBe(200);
    expect((await response.json()).data).toEqual([]);
  });

  it('answers an unknown key with 404 and a bad body with 400', async () => {
    const { base } = await start();
    const missing = await fetch(`${base}/_crypto/api/keys/nope?partition=shop`);
    expect(missing.status).toBe(404);
    const bad = await fetch(`${base}/_crypto/api/keys?partition=shop`, json('POST', {}));
    expect(bad.status).toBe(400);
  });
});

describe("console honors authorize's capabilities on its own partitions", () => {
  it('a viewer granted crypto:keys:read reads but cannot create, rotate, re-policy or delete', async () => {
    const { base, crypto } = await start({ capabilities: ['crypto:keys:read'] });
    await crypto.service.createKey(crypto.principal, {
      name: 'media',
      type: 'aes256-gcm',
      deletionAllowed: true,
    });
    const list = await fetch(`${base}/_crypto/api/keys?partition=shop&page=1&size=10`);
    expect(list.status).toBe(200);
    const meta = (await (await fetch(`${base}/_crypto/api/meta`)).json()) as {
      capabilities: string[];
    };
    expect(meta.capabilities).toEqual(['crypto:keys:read']);

    const attempts = [
      fetch(`${base}/_crypto/api/keys?partition=shop`, {
        ...json('POST', { name: 'other', type: 'aes256-gcm' }),
      }),
      fetch(`${base}/_crypto/api/keys/media/rotate?partition=shop`, json('POST', {})),
      fetch(`${base}/_crypto/api/keys/media?partition=shop`, {
        ...json('PATCH', { exportable: true }),
      }),
      fetch(`${base}/_crypto/api/keys/media?partition=shop`, json('DELETE')),
      fetch(`${base}/_crypto/api/keys/media/test?partition=shop`, json('POST', {})),
    ];
    for (const response of await Promise.all(attempts)) expect(response.status).toBe(403);
    const key = await crypto.service.getKey(crypto.principal, 'media');
    expect(key).toMatchObject({ latestVersion: 1, exportable: false });
  });

  it('crypto:keys:manage manages keys; an authorize without capabilities keeps full rights', async () => {
    const managed = await start({ capabilities: ['crypto:keys:manage'] });
    const created = await fetch(`${managed.base}/_crypto/api/keys?partition=shop`, {
      ...json('POST', { name: 'media', type: 'aes256-gcm' }),
    });
    expect(created.status).toBe(201);
    const full = await start();
    const again = await fetch(`${full.base}/_crypto/api/keys?partition=shop`, {
      ...json('POST', { name: 'media', type: 'aes256-gcm' }),
    });
    expect(again.status).toBe(201);
  });
});

describe('console per-viewer apps', () => {
  async function seeded(options: Parameters<typeof start>[0]) {
    const started = await start(options);
    for (const partition of ['shop', 'blog', 'admin']) {
      await started.crypto.service.createKey(
        { partition, capabilities: ['crypto:*'], actor: 'test' },
        { name: 'orders', type: 'aes256-gcm' },
      );
    }
    return started;
  }

  it('lists and serves only the apps the viewer was granted', async () => {
    const { base } = await seeded({ grant: ['blog'] });
    const meta = (await (await fetch(`${base}/_crypto/api/meta`)).json()) as {
      apps: string[];
      defaultPartition: string;
    };
    expect(meta.apps).toEqual(['blog']);
    expect(meta.defaultPartition).toBe('blog');
    expect((await fetch(`${base}/_crypto/api/keys?partition=blog`)).status).toBe(200);
    const refused = await fetch(`${base}/_crypto/api/keys?partition=shop`);
    expect(refused.status).toBe(403);
    // The default app is not a way around the grant either.
    expect((await fetch(`${base}/_crypto/api/keys`)).status).toBe(403);
    const write = await fetch(
      `${base}/_crypto/api/keys?partition=admin`,
      json('POST', { name: 'x', type: 'aes256-gcm' }),
    );
    expect(write.status).toBe(403);
  });

  it("keeps the static `apps` as the upper bound, and '*' or no grant means all of them", async () => {
    const bounded = await seeded({ grant: ['blog', 'admin'], apps: ['shop', 'blog'] });
    const meta = (await (await fetch(`${bounded.base}/_crypto/api/meta`)).json()) as {
      apps: string[];
    };
    expect(meta.apps).toEqual(['blog']);
    expect((await fetch(`${bounded.base}/_crypto/api/keys?partition=admin`)).status).toBe(403);

    const all = await seeded({ grant: '*' });
    const everything = (await (await fetch(`${all.base}/_crypto/api/meta`)).json()) as {
      apps: string[];
    };
    expect([...everything.apps].sort()).toEqual(['admin', 'blog', 'shop']);
  });
});

describe('console routes', () => {
  function makeConsole(path?: string): CryptoConsole {
    const crypto = memoryCrypto();
    return new CryptoConsole({
      service: crypto.service,
      config: resolveDashboardConfig({
        ...(path !== undefined ? { path } : {}),
        authorize: () => ({ allowed: true as const }),
      }),
      spaDir: '/nowhere',
      defaultPartition: 'shop',
      inProduction: true,
      topology: 'control-plane',
      logger: { warn: () => {}, info: () => {} },
    });
  }

  /** AdonisJS normalizes the trailing slash and refuses `/<path>` next to `/<path>/`. */
  function strictRouter(routes: Route[]) {
    const seen = new Set<string>();
    const register = (method: string) => (pattern: string, handler: Handler) => {
      const key = `${method} ${pattern.length > 1 ? pattern.replace(/\/+$/, '') : pattern}`;
      if (seen.has(key)) {
        throw new Error(`Duplicate route found. "${method}: ${key}" route already exists`);
      }
      seen.add(key);
      routes.push({ method, pattern, handler });
      return {};
    };
    return {
      get: register('GET'),
      post: register('POST'),
      patch: register('PATCH'),
      delete: register('DELETE'),
    };
  }

  it('registers the page once instead of `/<path>` and `/<path>/`', () => {
    const routes: Route[] = [];
    expect(() => makeConsole('/_crypto').register(strictRouter(routes))).not.toThrow();

    const pages = routes.filter(
      (route) =>
        route.method === 'GET' && (route.pattern === '/_crypto' || route.pattern === '/_crypto/'),
    );
    expect(pages).toHaveLength(1);
  });

  it('registers the root page once when mounted at `/`', () => {
    const routes: Route[] = [];
    expect(() => makeConsole('/').register(strictRouter(routes))).not.toThrow();

    expect(routes.filter((route) => route.method === 'GET' && route.pattern === '/')).toHaveLength(
      1,
    );
    expect(routes.some((route) => route.pattern === '/assets/:file')).toBe(true);
  });
});
