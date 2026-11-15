import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { IgnitorFactory } from '@adonisjs/core/factories';
import type { ApplicationService } from '@adonisjs/core/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCryptoKeyring } from '../../src/crypto/keyring.js';
import { openMaterial } from '../../src/crypto/material.js';
import { CryptoService } from '../../src/crypto/service.js';
import { defineConfig, stores } from '../../src/define_config.js';
import { agoraDoctorChecks } from '../../src/doctor/checks.js';
import { getRuntime } from '../../src/services/accessor.js';
import { MemoryStore } from '../../src/store/memory_store.js';

const check = (id: string) => {
  const found = agoraDoctorChecks.find((entry) => entry.id === id);
  if (!found) throw new Error(`no check ${id}`);
  return found;
};

/** A stub app: the checks read `config.get('crypto')` and `inProduction` only. */
function stubApp(config: unknown, inProduction = false): ApplicationService {
  return {
    config: { get: (key: string) => (key === 'crypto' ? config : undefined) },
    inProduction,
  } as unknown as ApplicationService;
}

describe('doctor checks', () => {
  let app: ApplicationService;

  beforeEach(async () => {
    mkdirSync(join(process.cwd(), 'test/unit/tmp'), { recursive: true });
    const ignitor = new IgnitorFactory()
      .merge({
        rcFileContents: { providers: [() => import('../../providers/crypto_provider.js')] },
        config: {
          crypto: defineConfig({
            topology: 'control-plane',
            verifyTenant: async () => null,
            store: stores.memory(),
            crypto: { keys: [{ id: 'root', secret: 'a-test-root-key-of-32-characters!' }] },
            console: false,
          }),
        },
      })
      .withCoreConfig()
      .withCoreProviders()
      .create(new URL('./tmp/', import.meta.url));
    app = ignitor.createApp('console') as ApplicationService;
    await app.init();
    await app.boot();
  });

  afterEach(async () => {
    await app.terminate();
  });

  it('reports the keyring, the store and every version opening', async () => {
    const keyring = await check('crypto.keyring').run(app);
    expect(keyring.status).toBe('ok');
    expect(keyring.message).toMatch(/crypto.keys/);

    expect((await check('crypto.database').run(app)).message).toMatch(/0 key/);

    const runtime = getRuntime();
    await runtime.service!.createKey(
      { partition: 'shop', capabilities: ['crypto:*'], actor: 'test' },
      { name: 'orders', type: 'aes256-gcm' },
    );
    expect((await check('crypto.database').run(app)).message).toMatch(/1 key/);
    const material = await check('crypto.key-material').run(app);
    expect(material.status).toBe('ok');
    expect(material.message).toMatch(/All 1 key version/);

    // A lost root is an error, not a warning: the material can never be re-created.
    const store = runtime.store as MemoryStore;
    const record = await store.getKey('shop', 'orders');
    const version = await store.version('shop', 'orders', 1);
    expect(record).not.toBeNull();
    expect(version).not.toBeNull();
    const otherService = new CryptoService({
      store,
      keyring: createCryptoKeyring({ appKey: 'another-root-key-of-32-characters!!' }),
    });
    await expect(
      openMaterial(otherService.keyring, 'shop', 'orders', 1, 'aes256-gcm', version!.sealed),
    ).rejects.toMatchObject({ code: 'unreadable' });
  });

  it('skips the key checks on a tenant', async () => {
    const tenant = stubApp(
      defineConfig({
        topology: 'tenant',
        tenant: { url: 'https://crypto.test/_crypto', partition: 'shop', token: 'secret' },
      }),
    );
    expect((await check('crypto.keyring').run(tenant)).status).toBe('skip');
    expect((await check('crypto.console').run(tenant)).status).toBe('skip');
    // `crypto.database` and `crypto.key-material` read the booted runtime (a module-level accessor),
    // so they belong to the app that is actually booted; a tenant's runtime has no store and skips.
  });

  it('flags a console without an authorize hook', async () => {
    const open = stubApp(defineConfig({ app: 'shop', store: stores.memory() }), false);
    const outsideProduction = await check('crypto.console').run(open);
    expect(outsideProduction.status).toBe('warn');

    const production = stubApp(defineConfig({ app: 'shop', store: stores.memory() }), true);
    expect((await check('crypto.console').run(production)).status).toBe('error');

    const gated = stubApp(
      defineConfig({ app: 'shop', store: stores.memory(), console: { authorize: () => true } }),
      true,
    );
    expect((await check('crypto.console').run(gated)).status).toBe('ok');
  });

  it('reports an unreachable crypto server from a tenant', async () => {
    const tenant = stubApp(
      defineConfig({
        topology: 'tenant',
        tenant: { url: 'http://127.0.0.1:1/_crypto', partition: 'shop', token: 'secret' },
      }),
    );
    const result = await check('crypto.tenant').run(tenant);
    expect(result.status).toBe('error');
    expect(result.fix).toMatch(/CRYPTO_URL/);
  });
});
