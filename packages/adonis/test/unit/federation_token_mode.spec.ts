import { afterEach, describe, expect, it, vi } from 'vitest';
import { CryptoService } from '../../src/crypto/service.js';
import {
  CONSOLE_COMMAND_KEY,
  commandKeyOpener,
  commandKeyReader,
  cryptoConsoleCommandHandler,
  ensureConsoleCommandKey,
} from '../../src/federation/console.js';
import {
  type ConsoleCommand,
  RedisConsoleChannel,
  UNAUTHORIZED_CONSOLE,
  UNSIGNED_CHANNEL,
} from '../../src/federation/redis_channel.js';
import { MemoryStore } from '../../src/store/memory_store.js';
import { testKeyring } from '../../src/testing/index.js';
import type { TenantVerifier } from '../../src/topology/verify.js';
import { RedisBus } from '../support/redis_bus.js';

const PREFIX = 'shop';
const COMMANDS = 'shop-crypto-console';
const REPLIES = 'shop-crypto-console-reply';
const seed = { partition: 'shop', capabilities: ['crypto:*'], actor: 'seed' };

/** A stand-in for authkitTenantVerifier: one token per console client. */
const verifyTenant: TenantVerifier = ({ token }) => {
  if (token === 'hub-manager') {
    return { partition: 'shop', capabilities: ['crypto:*'], clientId: 'hub' };
  }
  if (token === 'hub-reader') {
    return {
      partition: 'shop',
      capabilities: ['crypto:keys:read', 'crypto:encrypt:*', 'crypto:decrypt:*'],
      clientId: 'hub-ro',
    };
  }
  if (token === 'hub-other-app') {
    return { partition: 'billing', capabilities: ['crypto:*'], clientId: 'hub-billing' };
  }
  return null;
};

afterEach(() => {
  vi.restoreAllMocks();
});

async function setup() {
  const bus = new RedisBus();
  const store = new MemoryStore();
  const service = new CryptoService({ store, keyring: testKeyring() });
  await service.createKey(seed, { name: 'orders', type: 'aes256-gcm', deletionAllowed: true });
  // What the provider does at boot: the command key, in the app's own store.
  expect(await ensureConsoleCommandKey(service, 'shop')).toBe('created');
  expect(await ensureConsoleCommandKey(service, 'shop')).toBe('present');
  const handler = cryptoConsoleCommandHandler({ service, actions: true, partitions: ['shop'] });
  const seen: ConsoleCommand[] = [];
  const errors: unknown[] = [];
  const app = new RedisConsoleChannel({
    client: bus.connection(),
    prefix: PREFIX,
    verifyTenant,
    opener: commandKeyOpener(service, ['shop']),
  });
  await app.answer(
    async (command) => {
      seen.push(command);
      return handler(command);
    },
    { onError: (error) => errors.push(error) },
  );
  const consoleWith = (token: string, onReset?: () => void) =>
    new RedisConsoleChannel({
      client: bus.connection(),
      prefix: PREFIX,
      token: Object.assign(async () => token, { reset: () => onReset?.() }),
      // The console reads the key from the app's store (it already reads it), never from Redis.
      recipient: commandKeyReader(store, 'shop'),
    });
  return { bus, store, service, seen, errors, consoleWith };
}

const rotate = (name = 'orders', extra: Partial<ConsoleCommand> = {}): ConsoleCommand => ({
  id: crypto.randomUUID(),
  verb: 'rotateKey',
  args: [{ partition: 'shop', name }],
  actor: 'alice@hub',
  via: 'Hub',
  // The console always sends the viewer's capabilities (`crypto:*` when `authorize` does not narrow).
  capabilities: ['crypto:*'],
  ...extra,
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

describe('federated crypto console, token mode (authkit)', () => {
  it('runs a command whose token the app verifies, with nothing readable on Redis', async () => {
    const { bus, store, seen, consoleWith } = await setup();
    const reply = await consoleWith('hub-manager').send(rotate());
    expect(reply).toMatchObject({ ok: true, data: { name: 'orders', latestVersion: 2 } });
    expect((await store.getKey('shop', 'orders'))?.latestVersion).toBe(2);
    expect(seen[0]?.verified).toEqual({
      partition: 'shop',
      capabilities: ['crypto:*'],
      clientId: 'hub',
    });
    // The command and its token cross Redis sealed: a reader learns neither.
    const commands = bus.published.filter((p) => p.channel === COMMANDS).map((p) => p.message);
    expect(commands.join('\n')).not.toContain('hub-manager');
    expect(commands.join('\n')).not.toContain('rotateKey');
    expect(commands.join('\n')).not.toContain('alice@hub');
  });

  it('refuses an unknown token (and the console drops its cached token)', async () => {
    const { store, consoleWith } = await setup();
    let resets = 0;
    const reply = await consoleWith('stolen-or-made-up', () => {
      resets += 1;
    }).send(rotate());
    expect(reply).toMatchObject({ ok: false, error: { code: UNAUTHORIZED_CONSOLE, status: 401 } });
    expect(resets).toBe(1);
    expect((await store.getKey('shop', 'orders'))?.latestVersion).toBe(1);
  });

  it('lets the token decide the app and the capabilities, whatever the message claims', async () => {
    const { store, consoleWith } = await setup();
    // A token for another app cannot act on this one.
    const other = await consoleWith('hub-other-app').send(rotate());
    expect(other).toMatchObject({ ok: false, error: { status: 403 } });
    expect(!other.ok && other.error.message).toMatch(/token is for "billing"/);
    // A token without crypto:keys:manage cannot rotate, delete or change a policy, even when the
    // message claims every capability.
    const reader = consoleWith('hub-reader');
    for (const command of [
      rotate('orders', { capabilities: ['*'] }),
      rotate('orders', { verb: 'deleteKey', capabilities: ['crypto:*'] }),
      {
        ...rotate('orders', { verb: 'updateKeyPolicy', capabilities: ['crypto:*'] }),
        args: [{ partition: 'shop', name: 'orders', patch: { exportable: true } }],
      },
    ]) {
      const reply = await reader.send(command);
      expect(reply).toMatchObject({ ok: false, error: { code: 'forbidden' } });
    }
    expect(await store.getKey('shop', 'orders')).toMatchObject({
      latestVersion: 1,
      exportable: false,
    });
    // What the token allows still runs (a key test only encrypts and decrypts).
    const tested = await reader.send(rotate('orders', { verb: 'testKey' }));
    expect(tested).toMatchObject({ ok: true, data: { ok: true } });
    // The viewer's capabilities only narrow the token's.
    const narrowed = await consoleWith('hub-manager').send(
      rotate('orders', { capabilities: ['crypto:keys:read'] }),
    );
    expect(narrowed).toMatchObject({ ok: false, error: { code: 'forbidden' } });
  });

  it('never lets a console touch the command key itself', async () => {
    const { store, consoleWith } = await setup();
    const reply = await consoleWith('hub-manager').send(rotate(CONSOLE_COMMAND_KEY));
    expect(reply).toMatchObject({ ok: false, error: { status: 403 } });
    expect((await store.getKey('shop', CONSOLE_COMMAND_KEY))?.latestVersion).toBe(1);
  });

  it('refuses unsealed, forged, tampered, replayed and stale commands', async () => {
    const { bus, store, seen, errors, consoleWith } = await setup();
    const raw = bus.connection();
    // Someone with Redis access publishes a plain command claiming to be a verified console.
    await raw.publish(
      COMMANDS,
      JSON.stringify({
        ...rotate(),
        capabilities: ['*'],
        verified: { partition: 'shop', capabilities: ['*'] },
      }),
    );
    // …or seals one to the (public) command key without a token.
    const key = await commandKeyReader(store, 'shop')();
    const { sealTo } = await import('../../src/crypto-kit/index.js');
    const id = crypto.randomUUID();
    await raw.publish(
      COMMANDS,
      JSON.stringify({
        id,
        sealed: sealTo(
          key,
          JSON.stringify({ command: { ...rotate(), id, ts: Date.now() }, replySecret: 'x' }),
          { aad: JSON.stringify(['agora:console-command', 'crypto', PREFIX, id]) },
        ),
      }),
    );
    await settle();
    expect(seen).toHaveLength(0);
    expect(errors[0]).toMatchObject({ code: UNSIGNED_CHANNEL });
    expect((await store.getKey('shop', 'orders'))?.latestVersion).toBe(1);

    // A real command, then a copy under another id, a bit-flipped copy and a straight replay.
    await consoleWith('hub-manager').send(rotate());
    const sent = bus.published.find((p) => p.channel === COMMANDS && p.message.includes('sealed'))!;
    const wire = JSON.parse(sent.message) as { id: string; sealed: string };
    const flipped = wire.sealed.slice(0, -2) + (wire.sealed.endsWith('A') ? 'BB' : 'AA');
    await raw.publish(COMMANDS, JSON.stringify({ id: crypto.randomUUID(), sealed: wire.sealed }));
    await raw.publish(COMMANDS, JSON.stringify({ ...wire, sealed: flipped }));
    await raw.publish(COMMANDS, sent.message);
    await settle();
    expect(seen).toHaveLength(1);
    expect((await store.getKey('shop', 'orders'))?.latestVersion).toBe(2);

    // Two minutes later the same sealed command is stale, whatever its id.
    const before = errors.length;
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now + 120_000);
    await raw.publish(COMMANDS, sent.message);
    await settle();
    expect(errors.length).toBe(before + 1);
    expect(errors.at(-1)).toMatchObject({ code: UNSIGNED_CHANNEL });
    expect(String((errors.at(-1) as Error).message)).toMatch(/stale/);
    expect(seen).toHaveLength(1);
  });

  it('ignores a forged answer and waits for the app', async () => {
    const { bus, consoleWith } = await setup();
    const raw = bus.connection();
    await raw.subscribe(COMMANDS, (message) => {
      const { id } = JSON.parse(message) as { id: string };
      void raw.publish(REPLIES, JSON.stringify({ id, ok: true, data: { forged: true } }));
    });
    const reply = await consoleWith('hub-manager').send(rotate());
    expect(reply).toMatchObject({ ok: true, data: { name: 'orders', latestVersion: 2 } });
  });

  it('the console refuses to send when the app has not published its key', async () => {
    const bus = new RedisBus();
    const channel = new RedisConsoleChannel({
      client: bus.connection(),
      prefix: PREFIX,
      token: 'hub-manager',
      recipient: commandKeyReader(new MemoryStore(), 'shop'),
    });
    await expect(channel.send(rotate(), { timeoutMs: 100 })).rejects.toThrow(
      /no console-commands key yet/,
    );
    expect(bus.published).toEqual([]);
  });

  it('reports a command-key name taken by another key type instead of replacing it', async () => {
    const service = new CryptoService({ store: new MemoryStore(), keyring: testKeyring() });
    await service.createKey(seed, { name: CONSOLE_COMMAND_KEY, type: 'aes256-gcm' });
    await expect(ensureConsoleCommandKey(service, 'shop')).rejects.toThrow(/not a live x25519/);
  });
});
