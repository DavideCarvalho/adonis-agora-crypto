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
import { ensureConsoleCryptoKey } from '../../src/federation/console_modes.js';
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

  it('reports how console commands are authenticated, and errors when a side is not', async () => {
    const none = stubApp(
      defineConfig({ app: 'shop', store: stores.memory(), consoleCommands: { prefix: 'shop' } }),
    );
    const [unauthenticated] = (await check('crypto.console-commands').run(none)) as Array<{
      status: string;
      fix?: string;
    }>;
    expect(unauthenticated).toMatchObject({ status: 'error' });
    expect(unauthenticated!.fix).toMatch(
      /consoleCommands\.crypto.*consoleCommands\.secret.*consoleCommands\.verifyTenant.*node ace agora:doctor/s,
    );

    const withSecret = stubApp(
      defineConfig({
        app: 'shop',
        store: stores.memory(),
        consoleCommands: { prefix: 'shop', secret: 'x'.repeat(20) },
        console: {
          federatedApps: {
            auto: { store: new MemoryStore(), controlPlane: { prefix: 'auto' } },
            off: { store: new MemoryStore(), controlPlane: { prefix: 'off', crypto: false } },
          },
        },
      }),
    );
    const results = (await check('crypto.console-commands').run(withSecret)) as Array<{
      status: string;
      message: string;
    }>;
    expect(results.map((r) => r.status)).toEqual(['ok', 'ok', 'error']);
    expect(results[0]!.message).toMatch(/secret/);
    expect(results[1]!.message).toMatch(/crypto \(auto, key console-crypto/);
  });

  it("deep: the console's console-crypto key exists and round-trips", async () => {
    const hub = stubApp(
      defineConfig({
        app: 'hub',
        store: stores.memory(),
        console: {
          federatedApps: { shop: { store: new MemoryStore(), controlPlane: { prefix: 'shop' } } },
        },
      }),
    );
    const [missing] = (await check('crypto.console-commands-key').run(hub)) as Array<{
      status: string;
    }>;
    expect(missing).toMatchObject({ status: 'warn' });
    await ensureConsoleCryptoKey(getRuntime().service!, 'shop');
    const [ready] = (await check('crypto.console-commands-key').run(hub)) as Array<{
      status: string;
      message: string;
    }>;
    expect(ready).toMatchObject({ status: 'ok' });
    expect(ready!.message).toMatch(/encrypts and decrypts/);
  });

  it('deep: checks the app-side key with hasKey (no audit noise), never the decrypt probe', async () => {
    let probed = 0;
    const cipher = {
      encrypt: async () => ({ ciphertext: '' }),
      decrypt: async () => {
        probed += 1;
        throw new Error('crypto: no key named "console-crypto"');
      },
      hasKey: async ({ key }: { key: string }) => key === 'console-crypto',
    };
    const app = stubApp(
      defineConfig({
        app: 'shop',
        store: stores.memory(),
        console: false,
        consoleCommands: { prefix: 'shop', crypto: { cipher } },
      }),
    );
    const results = (await check('crypto.console-commands-key').run(app)) as Array<{
      status: string;
      message: string;
    }>;
    expect(results[0]).toMatchObject({ status: 'ok' });
    expect(probed).toBe(0);
    const missing = stubApp(
      defineConfig({
        app: 'shop',
        store: stores.memory(),
        console: false,
        consoleCommands: { prefix: 'shop', crypto: { cipher, key: 'console-other' } },
      }),
    );
    const [absent] = (await check('crypto.console-commands-key').run(missing)) as Array<{
      status: string;
    }>;
    expect(absent).toMatchObject({ status: 'error' });
    expect(probed).toBe(0);
  });

  it('skips instead of throwing when the app is not booted (--no-boot)', async () => {
    const notBooted = { config: undefined, inProduction: false } as unknown as ApplicationService;
    for (const id of ['crypto.keyring', 'crypto.tenant', 'crypto.console']) {
      const result = await check(id).run(notBooted);
      expect(result.status).toBe('skip');
      expect(result.message).toMatch(/not booted/);
    }
    const throwing = {
      config: {
        get: () => {
          throw new Error('no config');
        },
      },
      inProduction: true,
    } as unknown as ApplicationService;
    expect((await check('crypto.keyring').run(throwing)).status).toBe('skip');
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

  it('resolves a lazy tenant url, and reports one that does not resolve', async () => {
    const failing = stubApp(
      defineConfig({
        topology: 'tenant',
        tenant: {
          url: async () => {
            throw new Error('issuer down');
          },
          partition: 'shop',
          token: 'secret',
        },
      }),
    );
    const result = await check('crypto.tenant').run(failing);
    expect(result.status).toBe('error');
    expect(result.message).toMatch(/did not resolve: issuer down/);

    const resolved = stubApp(
      defineConfig({
        topology: 'tenant',
        tenant: { url: async () => 'http://127.0.0.1:1/_crypto', partition: 'shop', token: 'x' },
      }),
    );
    const unreachable = await check('crypto.tenant').run(resolved);
    expect(unreachable.message).toMatch(/^http:\/\/127\.0\.0\.1:1\/_crypto answered nothing/);
  });
});
