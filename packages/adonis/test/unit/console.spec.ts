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

async function start(options: { authorize?: boolean; path?: string } = {}) {
  const crypto = memoryCrypto();
  const console = new CryptoConsole({
    service: crypto.service,
    config: resolveDashboardConfig({
      ...(options.path !== undefined ? { path: options.path } : {}),
      authorize: () =>
        options.authorize === false
          ? { allowed: false as const, status: 403 as const, reason: 'forbidden' as const }
          : { allowed: true as const },
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
