import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { IgnitorFactory } from '@adonisjs/core/factories';
import { afterEach, describe, expect, it } from 'vitest';
import { defineConfig, stores } from '../../src/define_config.js';

/**
 * The console used to register `/<path>` and `/<path>/`; AdonisJS normalizes the trailing slash and
 * aborts the boot with `Duplicate route found`. This drives a real AdonisJS app through the real
 * provider up to `router.commit()` — the call that threw.
 */
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function bootWithConsole(path?: string) {
  const root = await mkdtemp(join(tmpdir(), 'crypto-console-boot-'));
  roots.push(root);
  const ignitor = new IgnitorFactory()
    .withCoreProviders()
    .withCoreConfig()
    .merge({
      config: {
        crypto: defineConfig({
          topology: 'control-plane',
          verifyTenant: () => null,
          store: stores.memory(),
          console: {
            ...(path !== undefined ? { path } : {}),
            authorize: () => ({ allowed: true }),
          },
        }),
      },
      rcFileContents: { providers: [() => import('../../providers/crypto_provider.js')] },
    })
    .create(pathToFileURL(`${root}/`));
  const app = ignitor.createApp('web');
  await app.init();
  await app.boot();
  return app;
}

describe('console routes in a real app', () => {
  it('commits the router with the console at its default mount path', async () => {
    const app = await bootWithConsole();
    const router = await app.container.make('router');
    expect(() => router.commit()).not.toThrow();
  });

  it('commits the router with a custom console path', async () => {
    const app = await bootWithConsole('/crypto-console');
    const router = await app.container.make('router');
    expect(() => router.commit()).not.toThrow();
  });
});
