import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { IgnitorFactory } from '@adonisjs/core/factories';
import type { ApplicationService } from '@adonisjs/core/types';
import { afterEach, describe, expect, it } from 'vitest';
import { type CryptoConfig, defineConfig, stores } from '../../src/define_config.js';
import { CONSOLE_COMMAND_KEY, commandKeyReader } from '../../src/federation/console.js';
import { CONSOLE_CRYPTO_KEY, RedisConsoleChannel } from '../../src/federation/redis_channel.js';
import { ConsoleAuthConfigError } from '../../src/index.js';
import type { CryptoRuntime } from '../../src/runtime.js';
import { MemoryStore } from '../../src/store/memory_store.js';
import { RedisBus } from '../support/redis_bus.js';

/** `consoleCommands` through the real provider: what a web process answers, and with what. */
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function boot(
  crypto: CryptoConfig,
  bus: RedisBus,
  setup?: ((app: ApplicationService) => void | Promise<void>) | Record<string, unknown>,
) {
  const extra = typeof setup === 'object' ? setup : {};
  const root = await mkdtemp(join(tmpdir(), 'crypto-console-commands-'));
  const ignitor = new IgnitorFactory()
    .withCoreProviders()
    .withCoreConfig()
    .merge({
      config: { crypto, ...extra },
      rcFileContents: { providers: [() => import('../../providers/crypto_provider.js')] },
    })
    .create(pathToFileURL(`${root}/`));
  const app = ignitor.createApp('web') as ApplicationService;
  await app.init();
  app.container.singleton(
    'redis' as never,
    () => ({ connection: () => bus.connection() }) as never,
  );
  if (typeof setup === 'function') await setup(app);
  cleanups.push(async () => {
    await app.terminate().catch(() => {});
    await rm(root, { recursive: true, force: true });
  });
  await app.boot();
  await app.start(() => {});
  return (await app.container.make('agora.crypto')) as CryptoRuntime;
}

const withRedis = { redis: { connection: 'main', connections: { main: {} } } };

const verifyTenant = ({ token }: { token?: string | undefined }) =>
  token === 'hub-manager' ? { partition: 'shop', capabilities: ['crypto:*'] } : null;

const testCommandKey = () => ({
  id: crypto.randomUUID(),
  verb: 'testKey',
  args: [{ partition: 'shop', name: CONSOLE_COMMAND_KEY }],
  capabilities: ['crypto:*'],
});

describe('consoleCommands in a real app', () => {
  it('a control plane answers for no partition until they are listed', async () => {
    const bus = new RedisBus();
    const runtime = await boot(
      defineConfig({
        topology: 'control-plane',
        verifyTenant,
        store: stores.memory(),
        console: false,
        consoleCommands: { prefix: 'hub', actions: true },
      }),
      bus,
    );
    // Token mode (the control plane's own verifyTenant), but no partition: no command key made.
    expect(await runtime.store!.partitions()).toEqual([]);
  });

  it('token mode: creates the command key in each listed partition and answers sealed commands', async () => {
    const bus = new RedisBus();
    const runtime = await boot(
      defineConfig({
        topology: 'control-plane',
        verifyTenant,
        store: stores.memory(),
        console: false,
        consoleCommands: { prefix: 'hub', actions: true, partitions: ['shop'] },
      }),
      bus,
    );
    const key = await runtime.store!.getKey('shop', CONSOLE_COMMAND_KEY);
    expect(key).toMatchObject({ type: 'x25519', createdBy: 'crypto:console-commands' });
    const console = new RedisConsoleChannel({
      client: bus.connection(),
      prefix: 'hub',
      token: 'hub-manager',
      recipient: commandKeyReader(runtime.store!, 'shop'),
    });
    // The command key itself is off limits to a console, even with a token for everything.
    const reply = await console.send(testCommandKey());
    expect(reply).toMatchObject({ ok: false, error: { status: 403 } });
    expect(!reply.ok && reply.error.message).toMatch(/managed by this app only/);
  });

  it('fails the boot of a web process when consoleCommands has no mode, naming the options', async () => {
    const bus = new RedisBus();
    await expect(
      boot(
        defineConfig({
          topology: 'standalone',
          app: 'shop',
          store: stores.memory(),
          console: false,
          crypto: { keys: [{ id: 'root', secret: 'a-test-root-key-of-32-characters!' }] },
          consoleCommands: { prefix: 'shop', actions: true },
        }),
        bus,
      ),
    ).rejects.toThrow(
      /consoleCommands needs authentication: set consoleCommands\.crypto.*configure authkit-client's `service` \(automatic: the console uses an authkit app-call token; grant it crypto:console:\* on this app\), or set consoleCommands\.secret.*consoleCommands\.verifyTenant \(your own verifier\)\. Run `node ace agora:doctor`/s,
    );
  });

  it('console side: seals with its own console-crypto key automatically, created at boot', async () => {
    const bus = new RedisBus();
    const runtime = await boot(
      defineConfig({
        topology: 'standalone',
        app: 'hub',
        store: stores.memory(),
        crypto: { keys: [{ id: 'root', secret: 'a-test-root-key-of-32-characters!' }] },
        console: {
          authorize: () => true,
          federatedApps: {
            shop: { store: new MemoryStore(), controlPlane: { prefix: 'shop' } },
          },
        },
      }),
      bus,
      withRedis,
    );
    expect(await runtime.store!.getKey('shop', CONSOLE_CRYPTO_KEY)).toMatchObject({
      type: 'aes256-gcm',
      createdBy: 'crypto:console',
    });
  });

  it('console side: a federated app that may act but has no mode fails the boot', async () => {
    const bus = new RedisBus();
    await expect(
      boot(
        defineConfig({
          topology: 'standalone',
          app: 'hub',
          store: stores.memory(),
          crypto: { keys: [{ id: 'root', secret: 'a-test-root-key-of-32-characters!' }] },
          console: {
            authorize: () => true,
            federatedApps: {
              shop: {
                store: new MemoryStore(),
                controlPlane: { prefix: 'shop', crypto: false },
              },
            },
          },
        }),
        bus,
        withRedis,
      ),
    ).rejects.toThrow(
      '[@adonis-agora/crypto] console.federatedApps["shop"]: commands to this app need authentication: boot @adonis-agora/crypto in this app (automatic), or set console.federatedApps["shop"].controlPlane.secret, or console.federatedApps["shop"].controlPlane.token — or actions: false to only browse it. Run `node ace agora:doctor` to see every Agora lib\'s console auth at once. Note: `crypto: false` turned the automatic crypto mode off.',
    );
  });

  it("app side: authkit-client's app-caller verifier is enough, with nothing in consoleCommands", async () => {
    const bus = new RedisBus();
    const runtime = await boot(
      defineConfig({
        topology: 'standalone',
        app: 'shop',
        store: stores.memory(),
        console: false,
        crypto: { keys: [{ id: 'root', secret: 'a-test-root-key-of-32-characters!' }] },
        consoleCommands: { prefix: 'shop', actions: true },
      }),
      bus,
      (app) => {
        app.container.singleton(
          'authkit.client' as never,
          () =>
            ({
              appCallerVerifier: () => ({
                verifyToken: async (token: string) =>
                  token === 'app-call'
                    ? { app: 'hub', capabilities: ['crypto:console:*'], clientId: 'hub' }
                    : null,
              }),
            }) as never,
        );
      },
    );
    // Token mode: the command key the console seals to is created in this app's partition.
    expect(await runtime.store!.getKey('shop', CONSOLE_COMMAND_KEY)).toMatchObject({
      type: 'x25519',
    });
    const console = new RedisConsoleChannel({
      client: bus.connection(),
      prefix: 'shop',
      token: 'app-call',
      recipient: commandKeyReader(runtime.store!, 'shop'),
    });
    await runtime.service!.createKey(
      { partition: 'shop', capabilities: ['crypto:*'], actor: 'seed' },
      { name: 'orders', type: 'aes256-gcm' },
    );
    const reply = await console.send({
      id: crypto.randomUUID(),
      verb: 'rotateKey',
      args: [{ partition: 'shop', name: 'orders' }],
      actor: 'ana@hub',
      capabilities: ['crypto:*'],
    });
    expect(reply).toMatchObject({ ok: true, data: { latestVersion: 2 } });
  });

  it('throws the app-side error in boot(), before the HTTP server would listen', async () => {
    const root = await mkdtemp(join(tmpdir(), 'crypto-console-commands-'));
    const ignitor = new IgnitorFactory()
      .withCoreProviders()
      .withCoreConfig()
      .merge({
        config: {
          crypto: defineConfig({
            topology: 'standalone',
            app: 'shop',
            store: stores.memory(),
            console: false,
            crypto: { keys: [{ id: 'root', secret: 'a-test-root-key-of-32-characters!' }] },
            consoleCommands: { prefix: 'shop', actions: true },
          }),
        },
        rcFileContents: { providers: [() => import('../../providers/crypto_provider.js')] },
      })
      .create(pathToFileURL(`${root}/`));
    const app = ignitor.createApp('web') as ApplicationService;
    cleanups.push(async () => {
      await app.terminate().catch(() => {});
      await rm(root, { recursive: true, force: true });
    });
    await app.init();
    await expect(app.boot()).rejects.toBeInstanceOf(ConsoleAuthConfigError);
  });

  it('never crashes on a bad message: garbage on the command channel is dropped, and it keeps serving', async () => {
    const bus = new RedisBus();
    const lines: string[] = [];
    const runtime = await boot(
      defineConfig({
        topology: 'control-plane',
        verifyTenant,
        store: stores.memory(),
        console: false,
        consoleCommands: { prefix: 'hub', actions: true, partitions: ['shop'] },
      }),
      bus,
      (app) => {
        // Record what the real logger is asked to write.
        app.container.resolving('logger' as never, (logger: unknown) => {
          const target = logger as Record<'info' | 'warn', (line: string) => void>;
          target.info = (line) => void lines.push(line);
          target.warn = (line) => void lines.push(line);
        });
      },
    );
    // The boot line: the modes, the command key as a short id only, and the actions switch.
    const bootLine = lines.find((line) => line.includes('; actions '));
    expect(bootLine).toMatch(
      /console commands: token \(the control plane's verifyTenant; sealed to key [\w-]{1,8}\); actions on$/,
    );
    const garbage = [
      'not json',
      '{',
      'null',
      '42',
      '[]',
      JSON.stringify({ id: 1, verb: {} }),
      JSON.stringify({ id: 'x', sealed: 7 }),
      JSON.stringify({ id: 'x', sealed: 'agora:pk1:garbage' }),
      JSON.stringify({ id: 'x', verb: 'rotateKey', mac: 'nope' }),
      JSON.stringify({ id: 'x', verb: 'rotateKey', args: 'oops', capabilities: 'all' }),
    ];
    const sender = bus.connection();
    for (const message of garbage) await sender.publish('hub-crypto-console', message);
    await new Promise((resolve) => setTimeout(resolve, 50));
    // Still serving: a real command is answered.
    await runtime.service!.createKey(
      { partition: 'shop', capabilities: ['crypto:*'], actor: 'seed' },
      { name: 'orders', type: 'aes256-gcm' },
    );
    const console = new RedisConsoleChannel({
      client: bus.connection(),
      prefix: 'hub',
      token: 'hub-manager',
      recipient: commandKeyReader(runtime.store!, 'shop'),
    });
    const reply = await console.send({
      id: crypto.randomUUID(),
      verb: 'rotateKey',
      args: [{ partition: 'shop', name: 'orders' }],
      capabilities: ['crypto:*'],
    });
    expect(reply).toMatchObject({ ok: true, data: { latestVersion: 2 } });
    // A refused token and a command without capabilities are refused with their reasons too.
    const stranger = new RedisConsoleChannel({
      client: bus.connection(),
      prefix: 'hub',
      token: 'not-a-token',
      recipient: commandKeyReader(runtime.store!, 'shop'),
    });
    const command = () => ({
      id: crypto.randomUUID(),
      verb: 'rotateKey',
      args: [{ partition: 'shop', name: 'orders' }],
    });
    expect(await stranger.send({ ...command(), capabilities: ['crypto:*'] })).toMatchObject({
      ok: false,
      error: { status: 401 },
    });
    expect(await console.send(command())).toMatchObject({
      ok: false,
      error: { code: 'capabilities-required' },
    });
    // Refused messages are logged once per reason, with the uniform reasons, never thrown.
    const refused = lines.filter((line) => line.includes('console commands: refused a command ('));
    expect(new Set(refused).size).toBe(refused.length);
    expect(refused).toEqual(
      expect.arrayContaining([
        '[@adonis-agora/crypto] console commands: refused a command (not JSON)',
        '[@adonis-agora/crypto] console commands: refused a command (no command id)',
        "[@adonis-agora/crypto] console commands: refused a command (did not open with this app's key)",
        '[@adonis-agora/crypto] console commands: refused a command (token refused)',
        '[@adonis-agora/crypto] console commands: refused a command (capabilities-required)',
        '[@adonis-agora/crypto] console commands: refused a command (mode not accepted here (this app accepts: token; the command came as secret))',
      ]),
    );
    expect(lines.join('\n')).not.toMatch(/unsigned\?/);
  });

  it('console side: the timeout says what to check', async () => {
    const bus = new RedisBus();
    // Someone listens but never answers (the app refused the command, say).
    await bus.connection().subscribe('shop-crypto-console', () => {});
    const console = new RedisConsoleChannel({
      client: bus.connection(),
      prefix: 'shop',
      app: 'Shop',
      secret: 'x'.repeat(20),
    });
    await expect(
      console.send(
        { id: crypto.randomUUID(), verb: 'rotateKey', args: [], capabilities: [] },
        { timeoutMs: 100 },
      ),
    ).rejects.toThrow(
      'no instance of "Shop" answered within 0.1s — the app may have refused the command (check its logs, or run `node ace agora:doctor` there)',
    );
  });
});
