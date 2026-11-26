import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { CryptoService } from '../../src/crypto/service.js';
import { sealTo } from '../../src/crypto-kit/index.js';
import { cryptoConsoleCommandHandler } from '../../src/federation/console.js';
import {
  CONSOLE_CRYPTO_KEY,
  type ConsoleCipher,
  type ConsoleCommand,
  RedisConsoleChannel,
  UNAUTHORIZED_CONSOLE,
  UNSIGNED_CHANNEL,
} from '../../src/federation/redis_channel.js';
import { serviceCipher } from '../../src/http/envelope.js';
import { MemoryStore } from '../../src/store/memory_store.js';
import { testKeyring } from '../../src/testing/index.js';
import type { TenantVerifier } from '../../src/topology/verify.js';
import { RedisBus } from '../support/redis_bus.js';

const COMMANDS = 'shop-crypto-console';
const REPLIES = 'shop-crypto-console-reply';
const seed = { partition: 'shop', capabilities: ['crypto:*'], actor: 'seed' };

/**
 * A stand-in for a crypto server the console and the app both reach (the Hub's, or a separate
 * crypto app): keys live here, and each caller gets a cipher limited to what its token may do.
 */
class FakeCryptoServer {
  readonly keys = new Map<string, Buffer>([[CONSOLE_CRYPTO_KEY, randomBytes(32)]]);
  readonly audit: Array<{ op: string; key: string; context?: string | undefined }> = [];

  cipherFor(allowed: { encrypt?: string[]; decrypt?: string[] }): ConsoleCipher {
    return {
      encrypt: async ({ key, plaintext, aad, context }) => {
        if (!allowed.encrypt?.includes(key)) throw new Error(`no crypto:encrypt:${key}`);
        const iv = randomBytes(12);
        const cipher = createCipheriv('aes-256-gcm', this.keys.get(key)!, iv);
        cipher.setAAD(Buffer.from(aad ?? ''));
        const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
        this.audit.push({ op: 'encrypt', key, context });
        return {
          ciphertext: `agora:ct1:${key}:1:${Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64url')}`,
        };
      },
      decrypt: async ({ key, ciphertext, aad, context }) => {
        if (!allowed.decrypt?.includes(key)) throw new Error(`no crypto:decrypt:${key}`);
        const raw = Buffer.from(ciphertext.split(':').pop()!, 'base64url');
        const decipher = createDecipheriv('aes-256-gcm', this.keys.get(key)!, raw.subarray(0, 12));
        decipher.setAAD(Buffer.from(aad ?? ''));
        decipher.setAuthTag(raw.subarray(12, 28));
        const plaintext = Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]);
        this.audit.push({ op: 'decrypt', key, context });
        return { plaintext: plaintext.toString('utf8') };
      },
    };
  }
}

const verifyTenant: TenantVerifier = ({ token }) =>
  token === 'hub-manager'
    ? { partition: 'shop', capabilities: ['crypto:*'], clientId: 'hub' }
    : null;

/** The owning app: its own keys and service; it answers commands sealed with `cipher`. */
async function owningApp(bus: RedisBus, cipher: ConsoleCipher, options: { verify?: boolean } = {}) {
  const store = new MemoryStore();
  const service = new CryptoService({ store, keyring: testKeyring() });
  await service.createKey(seed, { name: 'orders', type: 'aes256-gcm' });
  const handler = cryptoConsoleCommandHandler({ service, actions: true, partitions: ['shop'] });
  const seen: ConsoleCommand[] = [];
  const errors: unknown[] = [];
  const app = new RedisConsoleChannel({
    client: bus.connection(),
    prefix: 'shop',
    crypto: { cipher },
    ...(options.verify ? { verifyTenant } : {}),
  });
  await app.answer(
    async (command) => {
      seen.push(command);
      return handler(command);
    },
    { onError: (error) => errors.push(error) },
  );
  return { store, seen, errors };
}

async function setup(options: { verify?: boolean } = {}) {
  const bus = new RedisBus();
  const server = new FakeCryptoServer();
  // The app may only decrypt with the key (its crypto token: crypto:decrypt:console-crypto).
  const app = await owningApp(bus, server.cipherFor({ decrypt: [CONSOLE_CRYPTO_KEY] }), options);
  let resolved = 0;
  // The console may only encrypt with it.
  const console = (token?: string) =>
    new RedisConsoleChannel({
      client: bus.connection(),
      prefix: 'shop',
      crypto: {
        // Lazy, like `() => serviceCipher(crypto.service, 'shop')` in config/crypto.ts.
        cipher: () => {
          resolved += 1;
          return server.cipherFor({ encrypt: [CONSOLE_CRYPTO_KEY] });
        },
      },
      ...(token !== undefined ? { token } : {}),
    });
  return { bus, server, ...app, console, resolvedCount: () => resolved };
}

const rotate = (): ConsoleCommand => ({
  id: crypto.randomUUID(),
  verb: 'rotateKey',
  args: [{ partition: 'shop', name: 'orders' }],
  actor: 'alice@hub',
  via: 'Hub',
  capabilities: ['crypto:*'],
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

describe('federated crypto console, sealed with a crypto key', () => {
  it('runs a command the console encrypted and the app decrypted, with nothing readable on Redis', async () => {
    const { bus, server, store, seen, console, resolvedCount } = await setup();
    const channel = console();
    expect(resolvedCount()).toBe(0);
    const reply = await channel.send(rotate());
    expect(reply).toMatchObject({ ok: true, data: { latestVersion: 2 } });
    expect(resolvedCount()).toBe(1);
    expect((await store.getKey('shop', 'orders'))?.latestVersion).toBe(2);
    expect(seen[0]).toMatchObject({ verb: 'rotateKey', actor: 'alice@hub' });
    expect(seen[0]?.verified).toBeUndefined();
    const commands = bus.published.filter((p) => p.channel === COMMANDS).map((p) => p.message);
    expect(commands.join('\n')).not.toContain('rotateKey');
    expect(commands.join('\n')).not.toContain('alice@hub');
    // The crypto server audits both sides, with the command's channel and id as context.
    expect(server.audit.map((row) => row.op)).toEqual(['encrypt', 'decrypt']);
    expect(server.audit[0]?.context).toContain('agora:console-command');
  });

  it('refuses commands from someone who cannot encrypt with the key', async () => {
    const { bus, server, seen, errors } = await setup();
    const raw = bus.connection();
    // Another key of theirs, a made-up ciphertext under the right name, a command sealed to some
    // X25519 public key (anyone can), and a plain command.
    server.keys.set('mine', randomBytes(32));
    const theirs = server.cipherFor({ encrypt: ['mine'] });
    const { ciphertext } = await theirs.encrypt({ key: 'mine', plaintext: '{}', aad: 'x' });
    await raw.publish(COMMANDS, JSON.stringify({ id: crypto.randomUUID(), sealed: ciphertext }));
    await raw.publish(
      COMMANDS,
      JSON.stringify({
        id: crypto.randomUUID(),
        sealed: `agora:ct1:${CONSOLE_CRYPTO_KEY}:1:${randomBytes(64).toString('base64url')}`,
      }),
    );
    const { generateKeyPair } = await import('../../src/crypto-kit/index.js');
    const pair = generateKeyPair('x25519');
    await raw.publish(
      COMMANDS,
      JSON.stringify({ id: crypto.randomUUID(), sealed: sealTo(pair.publicKey, '{}') }),
    );
    await raw.publish(COMMANDS, JSON.stringify(rotate()));
    await settle();
    expect(seen).toHaveLength(0);
    expect(errors).toHaveLength(4);
    for (const error of errors) expect(error).toMatchObject({ code: UNSIGNED_CHANNEL });
  });

  it('with verifyTenant on the app, the command must also carry a valid token', async () => {
    const { seen, console } = await setup({ verify: true });
    const without = await console().send(rotate());
    expect(without).toMatchObject({ ok: false, error: { code: UNAUTHORIZED_CONSOLE } });
    const withToken = await console('hub-manager').send(rotate());
    expect(withToken).toMatchObject({ ok: true });
    expect(seen.at(-1)?.verified).toMatchObject({ partition: 'shop', clientId: 'hub' });
  });

  it('ignores a forged answer', async () => {
    const { bus, console } = await setup();
    const raw = bus.connection();
    await raw.subscribe(COMMANDS, (message) => {
      const { id } = JSON.parse(message) as { id: string };
      void raw.publish(REPLIES, JSON.stringify({ id, ok: true, data: 'forged' }));
    });
    const reply = await console().send(rotate());
    expect(reply.ok && reply.data).not.toBe('forged');
    expect(reply).toMatchObject({ ok: true, data: { latestVersion: 2 } });
  });

  it('says so when crypto is not ready yet', async () => {
    const bus = new RedisBus();
    const channel = new RedisConsoleChannel({
      client: bus.connection(),
      prefix: 'shop',
      crypto: { cipher: () => undefined as never },
    });
    await expect(channel.send(rotate(), { timeoutMs: 100 })).rejects.toThrow(
      /crypto\.cipher.*not ready/,
    );
  });

  it("works with this package's own service as the crypto server (crypto in the Hub)", async () => {
    const bus = new RedisBus();
    // The Hub's crypto service holds `console-crypto` in the owning app's partition.
    const hub = new CryptoService({ store: new MemoryStore(), keyring: testKeyring() });
    await hub.createKey(seed, { name: CONSOLE_CRYPTO_KEY, type: 'aes256-gcm' });
    // The app (a tenant of the Hub's crypto for this) may only decrypt with that key.
    const appPrincipal = {
      partition: 'shop',
      capabilities: [`crypto:decrypt:${CONSOLE_CRYPTO_KEY}`],
      actor: 'app:shop',
    };
    const { store, seen } = await owningApp(bus, {
      encrypt: (input) => hub.encrypt(appPrincipal, input),
      decrypt: (input) => hub.decrypt(appPrincipal, input),
    });
    // The Hub's console encrypts in process.
    const console = new RedisConsoleChannel({
      client: bus.connection(),
      prefix: 'shop',
      crypto: { cipher: () => serviceCipher(hub, 'shop', 'console') },
    });
    const reply = await console.send(rotate());
    expect(reply).toMatchObject({ ok: true, data: { latestVersion: 2 } });
    expect(seen).toHaveLength(1);
    expect((await store.getKey('shop', 'orders'))?.latestVersion).toBe(2);
    const audit = await hub.audit(seed, { page: 1, size: 10 });
    expect(audit.data.map((row) => row.operation).sort()).toEqual(['create', 'decrypt', 'encrypt']);
  });
});
