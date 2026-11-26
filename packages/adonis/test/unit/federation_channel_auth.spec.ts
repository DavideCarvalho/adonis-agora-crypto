import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type ConsoleCommand,
  RedisConsoleChannel,
  UNSIGNED_CHANNEL,
} from '../../src/federation/redis_channel.js';
import { RedisBus } from '../support/redis_bus.js';

const SECRET = 'federation-secret-0123456789';
const COMMANDS = 'shop-crypto-console';
const REPLIES = 'shop-crypto-console-reply';
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

afterEach(() => {
  vi.restoreAllMocks();
});

describe('federated crypto console channel is authenticated', () => {
  it('neither sends nor answers without a mode', async () => {
    const bus = new RedisBus();
    const channel = new RedisConsoleChannel({ client: bus.connection(), prefix: 'shop' });
    expect(channel.signed).toBe(false);
    await expect(channel.answer(async () => null)).rejects.toMatchObject({
      code: UNSIGNED_CHANNEL,
    });
    await expect(
      channel.send({ id: '1', verb: 'deleteKey', args: [] }, { timeoutMs: 100 }),
    ).rejects.toMatchObject({ code: UNSIGNED_CHANNEL });
    expect(bus.published).toEqual([]);
  });

  it('names a replay only on the instance that ran the command; a lost claim stays silent', async () => {
    const bus = new RedisBus();
    const refusals: Array<{ instance: number; reason: string }> = [];
    const ran: number[] = [];
    for (const instance of [0, 1]) {
      const app = new RedisConsoleChannel({
        client: bus.connection(),
        prefix: 'shop',
        secret: SECRET,
      });
      await app.answer(
        async () => {
          ran.push(instance);
          return null;
        },
        { onRefused: (reason) => refusals.push({ instance, reason }) },
      );
    }
    const console = new RedisConsoleChannel({
      client: bus.connection(),
      prefix: 'shop',
      secret: SECRET,
    });
    await console.send({ id: 'once', verb: 'rotateKey', args: [], capabilities: [] });
    await settle();
    // One instance ran it; the other lost the claim and said nothing.
    expect(ran).toHaveLength(1);
    expect(refusals).toEqual([]);

    // The same signed message again: only the instance that ran it reports the replay.
    const signed = bus.published.find((p) => p.message.includes('"once"'))!;
    await bus.connection().publish(COMMANDS, signed.message);
    await settle();
    expect(ran).toHaveLength(1);
    expect(refusals).toEqual([{ instance: ran[0], reason: 'replayed' }]);
  });

  it('refuses a secret shorter than 16 characters', () => {
    expect(
      () =>
        new RedisConsoleChannel({
          client: new RedisBus().connection(),
          prefix: 'shop',
          secret: 'short',
        }),
    ).toThrow(/at least 16/);
  });

  it('refuses unsigned, forged, tampered, replayed and stale commands, and runs a signed one', async () => {
    const bus = new RedisBus();
    const ran: ConsoleCommand[] = [];
    const errors: unknown[] = [];
    const app = new RedisConsoleChannel({
      client: bus.connection(),
      prefix: 'shop',
      secret: SECRET,
    });
    await app.answer(
      async (command) => {
        ran.push(command);
        return { ok: command.verb };
      },
      { onError: (error) => errors.push(error) },
    );
    const raw = bus.connection();
    const forged = {
      id: 'forged-1',
      verb: 'deleteKey',
      args: [{ partition: 'shop', name: 'orders' }],
      actor: 'alice',
      capabilities: ['*'],
    };
    await raw.publish(COMMANDS, JSON.stringify(forged));
    await raw.publish(
      COMMANDS,
      JSON.stringify({ ...forged, id: 'forged-2', ts: Date.now(), mac: 'AAAA' }),
    );
    await settle();
    expect(ran).toHaveLength(0);
    expect(errors.length).toBeGreaterThanOrEqual(2);

    const console = new RedisConsoleChannel({
      client: bus.connection(),
      prefix: 'shop',
      secret: SECRET,
    });
    const reply = await console.send({ id: 'real-1', verb: 'rotateKey', args: [], actor: 'bob' });
    expect(reply).toMatchObject({ ok: true, data: { ok: 'rotateKey' } });
    expect(ran).toHaveLength(1);
    expect(ran[0]).toMatchObject({ actor: 'bob' });
    expect(ran[0]).not.toHaveProperty('mac');

    // The same signed message published again (a replay) does not run twice.
    const signed = bus.published.find((p) => p.message.includes('"real-1"'))!;
    await raw.publish(COMMANDS, signed.message);
    await settle();
    expect(ran).toHaveLength(1);

    // A tampered copy (another actor, more capabilities, a verified claim) fails the MAC.
    for (const change of [
      { actor: 'mallory' },
      { capabilities: ['crypto:*'] },
      { verb: 'deleteKey' },
    ]) {
      const tampered = { ...JSON.parse(signed.message), id: crypto.randomUUID(), ...change };
      await raw.publish(COMMANDS, JSON.stringify(tampered));
    }
    // A `verified` the sender adds is never taken from the wire.
    await console.send({
      id: 'real-2',
      verb: 'rotateKey',
      args: [],
      verified: { partition: 'shop', capabilities: ['*'] },
    });
    await settle();
    expect(ran).toHaveLength(2);
    expect(ran[1]?.verified).toBeUndefined();

    // Two minutes later a signed command is stale, even under a fresh claim.
    const before = errors.length;
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now + 120_000);
    await raw.publish(COMMANDS, signed.message);
    await settle();
    expect(errors.length).toBe(before + 1);
    expect(ran).toHaveLength(2);
  });

  it('a different secret is refused', async () => {
    const bus = new RedisBus();
    const errors: unknown[] = [];
    const app = new RedisConsoleChannel({
      client: bus.connection(),
      prefix: 'shop',
      secret: SECRET,
    });
    await app.answer(async () => 'ran', { onError: (error) => errors.push(error) });
    const other = new RedisConsoleChannel({
      client: bus.connection(),
      prefix: 'shop',
      secret: 'another-secret-0123456789',
    });
    await expect(
      other.send({ id: 'x', verb: 'rotateKey', args: [] }, { timeoutMs: 100 }),
    ).rejects.toThrow(/answered/);
    expect(errors[0]).toMatchObject({ code: UNSIGNED_CHANNEL });
  });

  it('ignores a forged reply and waits for the signed one', async () => {
    const bus = new RedisBus();
    const raw = bus.connection();
    // A rogue subscriber answers every command first.
    await raw.subscribe(COMMANDS, (message) => {
      const { id } = JSON.parse(message) as { id: string };
      void raw.publish(REPLIES, JSON.stringify({ id, ok: true, data: { deleted: false } }));
    });
    const app = new RedisConsoleChannel({
      client: bus.connection(),
      prefix: 'shop',
      secret: SECRET,
    });
    await app.answer(async () => ({ deleted: true }));
    const console = new RedisConsoleChannel({
      client: bus.connection(),
      prefix: 'shop',
      secret: SECRET,
    });
    const reply = await console.send({ id: 'k-1', verb: 'deleteKey', args: [] });
    expect(reply).toMatchObject({ ok: true, data: { deleted: true } });
  });
});
