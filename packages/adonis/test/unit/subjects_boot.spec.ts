import { mkdtemp, rm } from 'node:fs/promises';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { IgnitorFactory } from '@adonisjs/core/factories';
import { afterEach, describe, expect, it } from 'vitest';
import type { CryptoConfig } from '../../src/define_config.js';
import { dataKeyStores, defineConfig, stores } from '../../src/define_config.js';
import { CryptoApi } from '../../src/http/api.js';
import { SubjectKeyError } from '../../src/subjects/errors.js';
import { memoryCrypto } from '../../src/testing/index.js';
import { sharedSecretVerifier } from '../../src/topology/verify.js';
import { addressOf, type Handler, serve } from '../http_harness.js';

/**
 * `subjects` in config/crypto.ts, through the real provider and `services/main`: standalone (in
 * process) and tenant (every control-plane call over real HTTP).
 */
const roots: string[] = [];
const servers: Server[] = [];
const apps: Array<{ terminate(): Promise<void> }> = [];

afterEach(async () => {
  for (const app of apps.splice(0)) await app.terminate();
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function boot(config: CryptoConfig) {
  const root = await mkdtemp(join(tmpdir(), 'crypto-subjects-boot-'));
  roots.push(root);
  const ignitor = new IgnitorFactory()
    .withCoreProviders()
    .withCoreConfig()
    .merge({
      config: { crypto: config },
      rcFileContents: { providers: [() => import('../../providers/crypto_provider.js')] },
    })
    .create(pathToFileURL(`${root}/`));
  const app = ignitor.createApp('web');
  await app.init();
  await app.boot();
  apps.push(app);
  const { default: crypto } = await import('../../services/main.js');
  return { app, crypto };
}

async function controlPlane() {
  const server = memoryCrypto({ partition: 'research' });
  const api = new CryptoApi({
    service: server.service,
    verifyTenant: sharedSecretVerifier({ partitions: { research: 'research-secret-0123456789' } }),
  });
  const routes: Array<{ method: string; pattern: string; handler: Handler }> = [];
  const add = (method: string) => (pattern: string, handler: Handler) => {
    routes.push({ method, pattern, handler });
    return {};
  };
  api.register({
    get: add('GET'),
    post: add('POST'),
    put: add('PUT'),
    patch: add('PATCH'),
    delete: add('DELETE'),
  } as never);
  const http = await serve(routes);
  servers.push(http);
  return { url: `${addressOf(http)}/_crypto`, server, http };
}

describe('subjects through the provider', () => {
  it('standalone: crypto.subjects and crypto.forgetSubject', async () => {
    const { crypto } = await boot(
      defineConfig({
        app: 'research',
        store: stores.memory(),
        console: false,
        subjects: { prefix: 'u_', requireType: false, store: dataKeyStores.memory() },
      }),
    );
    const sealed = await crypto.subjects.encrypt(12, 'interview transcript');
    expect(sealed.startsWith('agora:se1:u_12:')).toBe(true);
    expect(await crypto.subjects.decrypt(sealed, { anySubject: true })).toBe(
      'interview transcript',
    );
    await crypto.forgetSubject(12);
    await expect(crypto.subjects.decrypt(sealed, { anySubject: true })).rejects.toMatchObject({
      code: 'forgotten',
    });
  });

  it('without `subjects` the accessor says how to turn it on', async () => {
    const { crypto } = await boot(
      defineConfig({ app: 'research', store: stores.memory(), console: false }),
    );
    expect(() => crypto.subjects).toThrow(/subjects: \{\}/);
  });

  it('tenant: data keys come from the control plane over HTTP, then from the cache', async () => {
    const remote = await controlPlane();
    const { crypto } = await boot(
      defineConfig({
        topology: 'tenant',
        tenant: {
          url: remote.url,
          partition: 'research',
          token: 'research-secret-0123456789',
          retries: 0,
          timeoutMs: 2000,
          checkOnBoot: false,
        },
        subjects: { requireType: false, store: dataKeyStores.memory() },
      }),
    );
    const alice = await crypto.subjects.encrypt('alice', 'hers');
    const bob = await crypto.subjects.encrypt('bob', 'his');
    // The key lives on the control plane, deletable; this app holds no key material of its own.
    const key = await remote.server.service.getKey(remote.server.principal, 'subject_alice');
    expect(key.deletionAllowed).toBe(true);

    crypto.subjects.evict('bob');
    await new Promise<void>((resolve) => remote.http.close(() => resolve()));
    servers.splice(servers.indexOf(remote.http), 1);
    remote.http.closeAllConnections?.();

    expect(await crypto.subjects.decrypt(alice, { anySubject: true })).toBe('hers');
    const failure = await crypto.subjects
      .decrypt(bob, { anySubject: true })
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(SubjectKeyError);
    expect((failure as SubjectKeyError).code).toBe('unavailable');
  });
});
