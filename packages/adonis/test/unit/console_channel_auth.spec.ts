import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  CONSOLE_COMMAND_MAX_AGE_MS,
  type ConsoleCommand,
  consoleMacKey,
  RedisConsoleChannel,
} from '../../src/federation/redis_channel.js';
import { RedisBus } from '../support/redis_bus.js';

const SECRET = 'a-shared-secret-0123456789';
const PREFIX = 'et';
const COMMANDS = `${PREFIX}-crypto-console`;
const REPLIES = `${PREFIX}-crypto-console-reply`;

const command = (id = 'c1'): ConsoleCommand => ({
  id,
  verb: 'rotateKey',
  args: [{ partition: 'et', name: 'orders' }],
  actor: 'ana',
  capabilities: ['crypto:keys:manage'],
});

/** The same canonical form the channel signs (keys sorted). */
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((k) => record[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonical(record[k])}`)
    .join(',')}}`;
}

function signed(key: Buffer, kind: 'command' | 'reply', body: unknown): string {
  return createHmac('sha256', key)
    .update(`crypto-console:${kind}\n${canonical(body)}`)
    .digest('base64url');
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 5));

async function answering(bus: RedisBus) {
  const runs: ConsoleCommand[] = [];
  const channel = new RedisConsoleChannel({
    client: bus.connection(),
    prefix: PREFIX,
    secret: SECRET,
  });
  await channel.answer(async (cmd) => {
    runs.push(cmd);
    return { ran: cmd.verb, at: new Date(0) };
  });
  return { channel, runs };
}

const envelope = (key: Buffer, ts: number, cmd: ConsoleCommand, prefix = PREFIX) =>
  JSON.stringify({ v: 1, ts, command: cmd, mac: signed(key, 'command', [prefix, ts, cmd]) });

describe('authenticated crypto console channel', () => {
  it('runs a signed command once, and the console accepts the signed answer', async () => {
    const bus = new RedisBus();
    const { runs } = await answering(bus);
    const console = new RedisConsoleChannel({
      client: bus.connection(),
      prefix: PREFIX,
      secret: SECRET,
    });
    const reply = await console.send(command(), { timeoutMs: 500 });
    // A Date in the answer survives: the MAC is computed over the wire form.
    expect(reply).toEqual({
      id: 'c1',
      ok: true,
      data: { ran: 'rotateKey', at: new Date(0).toISOString() },
    });
    expect(runs).toHaveLength(1);
    // A replay of the same signed command, inside the window, finds its id claimed.
    const sent = bus.published.find((p) => p.channel === COMMANDS)!;
    await bus.connection().publish(COMMANDS, sent.message);
    await flush();
    expect(runs).toHaveLength(1);
  });

  it('drops unsigned, forged, wrongly keyed, stale and malformed commands without throwing', async () => {
    const bus = new RedisBus();
    const { runs } = await answering(bus);
    const raw = bus.connection();
    const key = consoleMacKey(SECRET, PREFIX);
    const wrong = consoleMacKey('another-secret-0123456789', PREFIX);
    const now = Date.now();

    await raw.publish(COMMANDS, JSON.stringify(command('bare')));
    await raw.publish(COMMANDS, '{not json');
    await raw.publish(COMMANDS, 'null');
    await raw.publish(COMMANDS, JSON.stringify({ v: 1, ts: now, command: 'x', mac: 'y' }));
    await raw.publish(COMMANDS, envelope(wrong, now, command('wrong-key')));
    const tampered = JSON.parse(envelope(key, now, command('tampered')));
    tampered.command.capabilities = ['crypto:*'];
    await raw.publish(COMMANDS, JSON.stringify(tampered));
    await raw.publish(
      COMMANDS,
      envelope(key, now - CONSOLE_COMMAND_MAX_AGE_MS - 1_000, command('stale')),
    );
    await raw.publish(COMMANDS, envelope(key, now, command('other-prefix'), 'hub'));
    await flush();
    expect(runs).toEqual([]);

    await raw.publish(COMMANDS, envelope(key, now, command('ok')));
    await flush();
    expect(runs.map((r) => r.id)).toEqual(['ok']);
  });

  it('the console ignores answers not signed with the secret', async () => {
    const bus = new RedisBus();
    const raw = bus.connection();
    await raw.subscribe(COMMANDS, (message) => {
      const { command: cmd } = JSON.parse(message) as { command: ConsoleCommand };
      const forged = { id: cmd.id, ok: true, data: { rotated: true } };
      void raw.publish(REPLIES, JSON.stringify(forged));
      void raw.publish(
        REPLIES,
        JSON.stringify({
          v: 1,
          reply: forged,
          mac: signed(consoleMacKey('another-secret-0123456789', PREFIX), 'reply', [
            PREFIX,
            forged,
          ]),
        }),
      );
    });
    const console = new RedisConsoleChannel({
      client: bus.connection(),
      prefix: PREFIX,
      secret: SECRET,
    });
    await expect(console.send(command(), { timeoutMs: 100 })).rejects.toThrow(/within 100ms/);
  });

  it('fails closed without a secret: nothing sent, nothing answered', async () => {
    const bus = new RedisBus();
    const console = new RedisConsoleChannel({ client: bus.connection(), prefix: PREFIX });
    expect(console.authenticated).toBe(false);
    await expect(console.send(command())).rejects.toThrow(/controlPlane\.secret/);
    expect(bus.published).toEqual([]);
    const app = new RedisConsoleChannel({ client: bus.connection(), prefix: PREFIX });
    await expect(app.answer(async () => null)).rejects.toThrow(/consoleCommands\.secret/);
    expect(
      () => new RedisConsoleChannel({ client: bus.connection(), prefix: PREFIX, secret: 'short' }),
    ).toThrow(/at least 16/);
  });
});
