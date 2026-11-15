import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, request as httpRequest } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ENVELOPE_FIELD, ENVELOPE_HEADER, ENVELOPE_VERSION } from '@adonis-agora/crypto-core';
import { IgnitorFactory } from '@adonisjs/core/factories';
import { TestUtils } from '@adonisjs/core/test_utils';
import type { ApplicationService } from '@adonisjs/core/types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type CryptoConfig, defineConfig, stores } from '../../src/define_config.js';
import { DISCOVERY_SLOT, ENVELOPE_KEY_HEADER } from '../../src/http/envelope_global.js';

/**
 * Two real AdonisJS applications, booted through the real provider lifecycle, calling each other
 * with plain `fetch`: one is the hub (crypto control plane), the other its tenant. The static map is
 * on the hub's side and telescope's discovery slot is on the caller's, so both identification paths
 * run end to end.
 */

const PROVIDER = () => import('../../providers/crypto_provider.js');

interface RealApp {
  app: ApplicationService;
  port: number;
  close(): Promise<void>;
}

async function freePort(): Promise<number> {
  const server = createNetServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

async function bootApp(options: {
  config: CryptoConfig;
  port: number;
  registerRoutes(router: {
    post(path: string, handler: unknown): unknown;
    use(m: unknown[]): unknown;
  }): void;
}): Promise<RealApp> {
  const root = await mkdtemp(join(tmpdir(), 'crypto-envelope-'));
  const { port } = options;
  const ignitor = new IgnitorFactory()
    .withCoreProviders()
    .withCoreConfig()
    .merge({
      config: { crypto: options.config },
      rcFileContents: { providers: [PROVIDER] },
    })
    .create(pathToFileURL(`${root}/`));
  const app = ignitor.createApp('web');
  await app.init();
  await app.boot();

  const router = await app.container.make('router');
  options.registerRoutes(router as never);
  // A real app parses bodies at the router level; the provider's middleware runs before it.
  (router as never as { use(m: unknown[]): unknown }).use([
    () => import('@adonisjs/core/bodyparser_middleware'),
  ]);

  process.env.HOST = '127.0.0.1';
  process.env.PORT = String(port);
  const utils = new TestUtils(app);
  await utils.boot();
  const closeServer = await utils.httpServer().start();

  return {
    app,
    port,
    async close() {
      await closeServer();
      await app.terminate();
      await rm(root, { recursive: true, force: true });
    },
  };
}

/** The route every app exposes: it proves the body was opened before the handler read it. */
function echoRoutes(app: { tag: string }) {
  return (router: {
    post(path: string, handler: unknown): unknown;
    use(m: unknown[]): unknown;
  }) => {
    router.post('/echo', (ctx: never) => {
      const context = ctx as unknown as {
        request: { body(): unknown };
        response: { json(body: unknown): unknown };
        agora?: { envelope?: { key: string; payload: unknown } };
      };
      return context.response.json({
        app: app.tag,
        received: context.request.body(),
        envelope: context.agora?.envelope?.key ?? null,
      });
    });
  };
}

let hub: RealApp;
let caller: RealApp;
let elsewhere: { close(): Promise<void>; port: number };

beforeAll(async () => {
  const [hubPort, callerPort] = [await freePort(), await freePort()];
  const hubUrl = `http://127.0.0.1:${hubPort}`;
  const callerUrl = `http://127.0.0.1:${callerPort}`;

  hub = await bootApp({
    port: hubPort,
    config: defineConfig({
      topology: 'control-plane',
      verifyTenant: async ({ token }) =>
        token === 'tenant-token' ? { partition: 'billing', capabilities: ['crypto:*'] } : null,
      store: stores.memory(),
      console: false,
      envelope: {
        key: 'svc-hub',
        partition: 'billing',
        // The static fallback: telescope is not installed here, but the hub still knows the caller.
        targets: { caller: callerUrl },
      },
    }),
    registerRoutes: echoRoutes({ tag: 'hub' }),
  });
  // The shared key lives on the crypto server, in the partition both apps authenticate as.
  const runtime = await hub.app.container.make('agora.crypto' as never);
  await (
    runtime as never as { service: { createKey(p: unknown, i: unknown): Promise<unknown> } }
  ).service.createKey(
    { partition: 'billing', capabilities: ['crypto:*'], actor: 'test' },
    { name: 'svc-hub', type: 'aes256-gcm' },
  );

  caller = await bootApp({
    port: callerPort,
    config: defineConfig({
      topology: 'tenant',
      tenant: {
        url: `${hubUrl}/_crypto`,
        partition: 'billing',
        token: 'tenant-token',
        checkOnBoot: false,
      },
      // No `targets`: the caller relies on telescope's discovery slot alone.
      envelope: { key: 'svc-hub' },
    }),
    registerRoutes: echoRoutes({ tag: 'caller' }),
  });

  // What telescope publishes for the fleet. The hub is discoverable; the caller is not, which is
  // what forces the hub's static map to be the one that identifies it.
  (globalThis as Record<symbol, unknown>)[DISCOVERY_SLOT] = {
    resolve: (name: string) =>
      name === 'hub' ? hubUrl : name === 'caller' ? callerUrl : undefined,
    appOf: (origin: string) =>
      origin === hubUrl ? 'hub' : origin === callerUrl ? 'caller' : undefined,
    subscribe: () => () => {},
  };

  // A third origin nobody configured: it must receive plaintext.
  const plain = createServer();
  await new Promise<void>((resolve) => plain.listen(0, '127.0.0.1', resolve));
  elsewhere = {
    port: (plain.address() as { port: number }).port,
    close: () =>
      new Promise<void>((resolve) => {
        plain.close(() => resolve());
      }),
  };
  plain.on('request', (request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      response.setHeader('content-type', 'application/json');
      response.end(
        JSON.stringify({
          raw: Buffer.concat(chunks).toString('utf8'),
          envelope: request.headers[ENVELOPE_HEADER] ?? null,
        }),
      );
    });
  });
});

afterAll(async () => {
  delete (globalThis as Record<symbol, unknown>)[DISCOVERY_SLOT];
  await elsewhere?.close();
  await caller?.close();
  await hub?.close();
});

/** A client that never goes through undici: proof that plain HTTP callers keep working. */
function plainPost(port: number, body: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        host: '127.0.0.1',
        port,
        path: '/echo',
        method: 'POST',
        headers: { 'content-type': 'application/json' },
      },
      (response) => {
        let text = '';
        response.on('data', (chunk) => {
          text += String(chunk);
        });
        response.on('end', () => resolve({ status: response.statusCode ?? 0, body: text }));
      },
    );
    request.on('error', reject);
    request.end(body);
  });
}

const json = (body: unknown) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

describe('two real apps, plain fetch', () => {
  it('caller → hub: discovery identifies the app and the hub opens the body before the route', async () => {
    const response = await fetch(`http://127.0.0.1:${hub.port}/echo`, json({ hello: 'hub' }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      app: 'hub',
      received: { hello: 'hub' },
      envelope: 'svc-hub',
    });
  });

  it('hub → caller: the static map identifies the app and the tenant opens it through its crypto server', async () => {
    const response = await fetch(`http://127.0.0.1:${caller.port}/echo`, json({ hello: 'caller' }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      app: 'caller',
      received: { hello: 'caller' },
      envelope: 'svc-hub',
    });
  });

  it('leaves an unconfigured origin in plaintext', async () => {
    const response = await fetch(
      `http://127.0.0.1:${elsewhere.port}/anything`,
      json({ clear: true }),
    );
    expect(await response.json()).toEqual({ raw: '{"clear":true}', envelope: null });
  });

  it('answers 400 with no detail when an envelope does not open', async () => {
    const response = await fetch(`http://127.0.0.1:${hub.port}/echo`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [ENVELOPE_HEADER]: ENVELOPE_VERSION,
        [ENVELOPE_KEY_HEADER]: 'nope',
      },
      body: JSON.stringify({ [ENVELOPE_FIELD]: 'dGFtcGVyZWQ=' }),
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { code: string; error: string };
    expect(body.code).toBe('invalid');
    expect(body.error).toBe('crypto: the request envelope could not be opened');
    expect(JSON.stringify(body)).not.toContain('nope');
  });

  it('passes a plain, unsealed request through (a caller outside the hub keeps working)', async () => {
    const response = await plainPost(hub.port, JSON.stringify({ unsealed: true }));
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual({
      app: 'hub',
      received: { unsealed: true },
      envelope: null,
    });
  });
});
