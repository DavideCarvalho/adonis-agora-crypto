import { describe, expect, it } from 'vitest';
import { CryptoService } from '../../src/crypto/service.js';
import { defineConfig, stores } from '../../src/define_config.js';
import {
  buildFederatedCryptoApp,
  cryptoConsoleCommandHandler,
  type FederatedCryptoAppConfig,
} from '../../src/federation/console.js';
import {
  type AuthkitClientLike,
  resolveAppCommandModes,
  resolveConsoleSideMode,
  tokenUnavailableLog,
} from '../../src/federation/console_modes.js';
import {
  CONSOLE_CRYPTO_KEY,
  type ConsoleCipher,
  RedisConsoleChannel,
} from '../../src/federation/redis_channel.js';
import { MemoryStore } from '../../src/store/memory_store.js';
import { testKeyring } from '../../src/testing/index.js';
import { RedisBus } from '../support/redis_bus.js';

/**
 * Automatic crypto mode on the console side (the Hub embeds a crypto server, so it seals with its
 * own `console-crypto` key in the app's partition), and authkit app-call tokens on both sides.
 */

const seed = { partition: 'shop', capabilities: ['crypto:*'], actor: 'seed' };

/** The owning app's client of the Hub's crypto server: decrypt-only, in its own partition. */
const hubClientFor = (hub: CryptoService, partition: string): ConsoleCipher => {
  const principal = {
    partition,
    capabilities: ['crypto:decrypt:console-*'],
    actor: `app:${partition}`,
  };
  return {
    encrypt: (input) => hub.encrypt(principal, input),
    decrypt: (input) => hub.decrypt(principal, input),
  };
};

/** A stand-in for `@adonis-agora/authkit-client`: app-call tokens and their verifier. */
function fakeAuthkit(grants: Record<string, string[]>): AuthkitClientLike & { resets: number } {
  const client = {
    resets: 0,
    appCallTokens: () => ({
      token: async (app: string) => `app-call:hub->${app}`,
      reset: () => {
        client.resets += 1;
      },
    }),
    appCallerVerifier: () => ({
      verifyToken: async (token: string) => {
        const caps = grants[token];
        return caps ? { app: 'hub', capabilities: caps, clientId: 'hub-client' } : null;
      },
    }),
  };
  return client;
}

async function owningApp(
  bus: RedisBus,
  options: ConstructorParameters<typeof RedisConsoleChannel>[0] extends infer O
    ? Omit<O & object, 'client' | 'prefix'>
    : never,
) {
  const store = new MemoryStore();
  const service = new CryptoService({ store, keyring: testKeyring() });
  await service.createKey(seed, { name: 'orders', type: 'aes256-gcm' });
  const handler = cryptoConsoleCommandHandler({ service, actions: true, partitions: ['shop'] });
  const channel = new RedisConsoleChannel({ client: bus.connection(), prefix: 'shop', ...options });
  const errors: unknown[] = [];
  await channel.answer(handler, { onError: (error) => errors.push(error) });
  return { store, service, errors, close: () => channel.close() };
}

const entry = (
  controlPlane: Partial<Extract<FederatedCryptoAppConfig['controlPlane'], { prefix: string }>> = {},
  extra: Partial<FederatedCryptoAppConfig> = {},
): FederatedCryptoAppConfig => ({
  store: new MemoryStore(),
  partition: 'shop',
  controlPlane: { prefix: 'shop', ...controlPlane },
  timeoutMs: 500,
  ...extra,
});

describe('console side: automatic crypto mode', () => {
  it('seals with its own console-crypto key, created on first use, with no auth line', async () => {
    const bus = new RedisBus();
    const hub = new CryptoService({ store: new MemoryStore(), keyring: testKeyring() });
    const app = await owningApp(bus, { crypto: { cipher: hubClientFor(hub, 'shop') } });
    const created: string[] = [];
    const federated = await buildFederatedCryptoApp('shop', entry(), {
      db: async () => {
        throw new Error('unused');
      },
      redis: async () => bus.connection(),
      service: hub,
      onKeyCreated: (partition, key) => created.push(`${partition}/${key}`),
    });
    const rotated = await federated.rotateKey('orders', {
      actor: 'ana@hub',
      capabilities: ['crypto:*'],
    });
    expect(rotated).toMatchObject({ name: 'orders', latestVersion: 2 });
    expect(created).toEqual([`shop/${CONSOLE_CRYPTO_KEY}`]);
    expect(await hub.store.getKey('shop', CONSOLE_CRYPTO_KEY)).toMatchObject({
      type: 'aes256-gcm',
      createdBy: 'crypto:console',
    });
    // The command is only ciphertext on Redis.
    const commands = bus.published.filter((p) => p.channel === 'shop-crypto-console');
    expect(commands).toHaveLength(1);
    expect(commands[0]!.message).not.toContain('orders');
    await app.close();
    await federated.close();
  });

  it('explicit options win, crypto: false turns it off, actions: false browses', () => {
    expect(resolveConsoleSideMode('shop', entry()).kind).toBe('crypto-auto');
    expect(resolveConsoleSideMode('shop', entry()).describe).toBe(
      'crypto (auto, key console-crypto, partition shop)',
    );
    const secret = resolveConsoleSideMode('shop', entry({ secret: 'x'.repeat(20) }));
    expect(secret.kind).toBe('secret');
    const token = resolveConsoleSideMode('shop', entry({ token: 'tok' }));
    expect(token.kind).toBe('token');
    expect(resolveConsoleSideMode('shop', entry({ crypto: false })).kind).toBe('unauthenticated');
    expect(resolveConsoleSideMode('shop', entry({ crypto: false }, { actions: false })).kind).toBe(
      'browse-only',
    );
  });

  it('adds the authkit app-call token on top, unless token: false', () => {
    const authkit = fakeAuthkit({});
    const auto = resolveConsoleSideMode('shop', entry(), { authkit });
    expect(auto.kind).toBe('crypto-auto');
    expect(auto.describe).toMatch(/\+ token \(authkit app-call, auto\)/);
    expect(auto.token).toBeTypeOf('function');
    const off = resolveConsoleSideMode('shop', entry({ token: false }), { authkit });
    expect(off.token).toBeUndefined();
    // With crypto off, the app-call token alone is token mode (sealed to the app's key).
    const tokenOnly = resolveConsoleSideMode('shop', entry({ crypto: false }), { authkit });
    expect(tokenOnly.kind).toBe('token');
  });
});

describe('app side', () => {
  const standalone = (consoleCommands: Record<string, unknown>) =>
    defineConfig({
      topology: 'standalone',
      app: 'shop',
      store: stores.memory(),
      console: false,
      consoleCommands: { prefix: 'shop', ...consoleCommands },
    } as never);

  it('resolves no mode by itself without authkit (its crypto is not the console’s)', () => {
    expect(resolveAppCommandModes(standalone({}))?.modes).toEqual([]);
  });

  it("uses authkit's app-caller verifier automatically, unless verifyTenant: false", () => {
    const authkit = fakeAuthkit({});
    const auto = resolveAppCommandModes(standalone({}), { authkit });
    // `{sealedTo}` becomes the command key's short id in the boot log.
    expect(auto?.modes).toEqual(['token (authkit app-call, auto; sealed to {sealedTo})']);
    expect(resolveAppCommandModes(standalone({ verifyTenant: false }), { authkit })?.modes).toEqual(
      [],
    );
  });

  it("falls back to a control plane's own verifyTenant, unless verifyTenant: false", () => {
    const plane = (consoleCommands: Record<string, unknown>) =>
      defineConfig({
        topology: 'control-plane',
        verifyTenant: () => null,
        store: stores.memory(),
        console: false,
        consoleCommands: { prefix: 'hub', ...consoleCommands },
      } as never);
    expect(resolveAppCommandModes(plane({}))?.modes[0]).toMatch(/the control plane's verifyTenant/);
    expect(resolveAppCommandModes(plane({ verifyTenant: false }))?.modes).toEqual([]);
  });

  it('explicit crypto, with a token checked when one is sent', () => {
    const cipher = {
      encrypt: async () => ({ ciphertext: '' }),
      decrypt: async () => ({ plaintext: '' }),
    };
    const modes = resolveAppCommandModes(standalone({ crypto: { cipher } }), {
      authkit: fakeAuthkit({}),
    });
    expect(modes?.cryptoToken).toBe('optional');
    expect(modes?.modes.slice(0, 2)).toEqual([
      'crypto (key console-crypto)',
      'token checked when sent (authkit app-call, auto)',
    ]);
  });
});

describe('authkit app-call tokens, end to end', () => {
  async function pair(grants: Record<string, string[]>) {
    const bus = new RedisBus();
    const hub = new CryptoService({ store: new MemoryStore(), keyring: testKeyring() });
    const authkit = fakeAuthkit(grants);
    const app = await owningApp(bus, {
      crypto: { cipher: hubClientFor(hub, 'shop') },
      verifyAppCall: async (token) =>
        (await authkit.appCallerVerifier().verifyToken(token)) ?? null,
      cryptoToken: 'required',
    });
    const federated = await buildFederatedCryptoApp('shop', entry(), {
      db: async () => {
        throw new Error('unused');
      },
      redis: async () => bus.connection(),
      service: hub,
      authkit,
    });
    return { app, federated, authkit };
  }

  it('the audience binds the token, so its partition is the caller; crypto:console:write grants the key operations', async () => {
    const { app, federated } = await pair({ 'app-call:hub->shop': ['crypto:console:*'] });
    const rotated = await federated.rotateKey('orders', {
      actor: 'ana@hub',
      capabilities: ['crypto:*'],
    });
    expect(rotated).toMatchObject({ latestVersion: 2 });
    const audit = await app.service.audit(seed, {
      page: 1,
      size: 5,
      filters: { operation: 'rotate' },
    });
    expect(audit.data[0]).toMatchObject({ actor: 'ana@hub', result: 'ok' });
    await app.close();
    await federated.close();
  });

  it('caps the command with what authkit granted the console app', async () => {
    const { app, federated } = await pair({ 'app-call:hub->shop': ['crypto:console:read'] });
    await expect(
      federated.rotateKey('orders', { actor: 'ana@hub', capabilities: ['crypto:*'] }),
    ).rejects.toMatchObject({ status: 403 });
    await app.close();
    await federated.close();
  });

  it('a refused token answers 401 and resets the token source', async () => {
    const { app, federated, authkit } = await pair({});
    await expect(
      federated.rotateKey('orders', { actor: 'ana@hub', capabilities: ['crypto:*'] }),
    ).rejects.toMatchObject({ status: 401 });
    expect(authkit.resets).toBe(1);
    await app.close();
    await federated.close();
  });
});

describe('an automatic authkit token never blocks a crypto command (§13b)', () => {
  const failingAuthkit = (): AuthkitClientLike & { minted: number } => {
    const client = {
      minted: 0,
      appCallTokens: () => ({
        token: async () => {
          client.minted += 1;
          throw new Error('invalid_target');
        },
      }),
    };
    return client;
  };

  it('sends crypto-only, says once what to grant, and does not retry within 5 minutes', async () => {
    const bus = new RedisBus();
    const hub = new CryptoService({ store: new MemoryStore(), keyring: testKeyring() });
    const app = await owningApp(bus, { crypto: { cipher: hubClientFor(hub, 'shop') } });
    const authkit = failingAuthkit();
    const unavailable: string[] = [];
    const federated = await buildFederatedCryptoApp('shop', entry(), {
      db: async () => {
        throw new Error('unused');
      },
      redis: async () => bus.connection(),
      service: hub,
      authkit,
      onTokenUnavailable: (id, partition, reason) =>
        unavailable.push(`${id}/${partition}: ${reason}`),
    });
    const meta = { actor: 'ana@hub', capabilities: ['crypto:*'] };
    await expect(federated.rotateKey('orders', meta)).resolves.toMatchObject({ latestVersion: 2 });
    await expect(federated.rotateKey('orders', meta)).resolves.toMatchObject({ latestVersion: 3 });
    expect(unavailable).toEqual(['shop/shop: invalid_target']);
    expect(authkit.minted).toBe(1);
    await app.close();
    await federated.close();
  });

  it.each([
    ['invalid_target', 'info'],
    ['the app "shop" is not granted to this client', 'info'],
    ['fetch failed: ECONNREFUSED', 'warn'],
    ['invalid_client', 'warn'],
    ['No grant for this app', 'info'],
    ['authkit answered 400: invalid_target (urn:agora:app:shop)', 'info'],
    ['unauthorized_client', 'warn'],
  ] as const)('logs %s as %s, same wording', (reason, level) => {
    expect(tokenUnavailableLog('shop', 'shop', reason)).toEqual({
      level,
      line: `[@adonis-agora/crypto] console commands to "shop": sending without an authkit app-call token (crypto only): ${reason}. To attach it: grant the console's service client crypto:console:* on "shop" in authkit.`,
    });
  });

  it('without crypto the token is required: the error says what to grant', async () => {
    const bus = new RedisBus();
    const federated = await buildFederatedCryptoApp('shop', entry({ crypto: false }), {
      db: async () => {
        throw new Error('unused');
      },
      redis: async () => bus.connection(),
      authkit: failingAuthkit(),
    });
    await expect(
      federated.rotateKey('orders', { actor: 'ana@hub', capabilities: ['crypto:*'] }),
    ).rejects.toThrow(
      /invalid_target\. To attach it: grant the console's service client crypto:console:\* on "shop" in authkit\./,
    );
    await federated.close();
  });
});

describe('bring your own crypto', () => {
  it('a third-party cipher format is recognized through crypto.owns', async () => {
    const bus = new RedisBus();
    // A toy "KMS": base64 with its own prefix (not agora:ct1).
    const kms: ConsoleCipher = {
      encrypt: async ({ plaintext }) => ({
        ciphertext: `kms:v1:${Buffer.from(plaintext).toString('base64url')}`,
      }),
      decrypt: async ({ ciphertext }) => ({
        plaintext: Buffer.from(ciphertext.slice('kms:v1:'.length), 'base64url').toString(),
      }),
    };
    const owns = (ciphertext: string) => ciphertext.startsWith('kms:v1:');
    const app = await owningApp(bus, { crypto: { cipher: kms, owns } });
    const console = new RedisConsoleChannel({
      client: bus.connection(),
      prefix: 'shop',
      crypto: { cipher: kms },
    });
    const reply = await console.send({
      id: crypto.randomUUID(),
      verb: 'rotateKey',
      args: [{ partition: 'shop', name: 'orders' }],
      actor: 'ana',
      capabilities: ['crypto:*'],
    });
    expect(reply).toMatchObject({ ok: true, data: { latestVersion: 2 } });
    await app.close();
    await console.close();
  });
});
