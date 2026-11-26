import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

/**
 * The Redis channel a federated console talks to another app over: the console publishes a command
 * on `<prefix>-<topic>-console`, every instance of the owning app hears it, the one that wins
 * `SET <prefix>-<topic>-console-claim:<id> NX PX` runs it, and the answer comes back on
 * `<prefix>-<topic>-console-reply`. The same design as `@adonis-agora/durable`'s and
 * `@adonis-agora/media`'s console commands, on channels of its own, so all of them can share an
 * app's prefix. This file is copied between `@adonis-agora/config` and `@adonis-agora/crypto`
 * (only {@link CONSOLE_TOPIC} differs).
 */

/** This package's part of the channel names. */
export const CONSOLE_TOPIC = 'crypto';
const PACKAGE = `@adonis-agora/${CONSOLE_TOPIC}`;

/** One command sent to the owning app. Arguments and answer are plain JSON. */
export interface ConsoleCommand {
  id: string;
  verb: string;
  args: unknown[];
  /** Who acted in the console, recorded by the owning app as the actor. */
  actor?: string;
  /** The capabilities the console's `authorize` granted that viewer, when it said. */
  capabilities?: string[];
  /** The console that sent it (its `appLabel`), for the owning app's log and audit. */
  via?: string;
}

/** The owning app's answer to a {@link ConsoleCommand}. */
export type ConsoleReply =
  | { id: string; ok: true; data: unknown }
  | { id: string; ok: false; error: { message: string; code?: string; status?: number } };

/** An `ioredis` client: pub/sub needs a dedicated connection, made with `duplicate()`. */
export interface IoredisLike {
  publish(channel: string, message: string): Promise<unknown>;
  set?(key: string, value: string, px: 'PX', ms: number, nx: 'NX'): Promise<unknown>;
  duplicate(): IoredisSubscriberLike;
}

export interface IoredisSubscriberLike {
  subscribe(...channels: string[]): unknown;
  on(event: 'message', listener: (channel: string, message: string) => void): unknown;
  disconnect?(): void;
}

/** An `@adonisjs/redis` connection: it keeps its own subscriber and hands each payload over. */
export interface AdonisRedisLike {
  publish(channel: string, message: string): Promise<unknown>;
  set?(key: string, value: string, px: 'PX', ms: number, nx: 'NX'): Promise<unknown>;
  subscribe(channel: string, handler: (message: string) => void): unknown;
  unsubscribe?(channel: string): unknown;
}

export type RedisLike = IoredisLike | AdonisRedisLike;

/** How long a command waits for its answer by default. */
export const CONSOLE_COMMAND_TIMEOUT_MS = 15_000;
/** How long the claim on a command lives (longer than any answer is waited for). */
const CLAIM_TTL_MS = 120_000;
/**
 * How old (or how far in the future) a command may be. Shorter than {@link CLAIM_TTL_MS}, so a
 * command replayed inside the window finds its claim taken, and one replayed later is stale.
 */
export const CONSOLE_COMMAND_MAX_AGE_MS = 60_000;

/** A shared secret as configured: a string, or a `Secret` (`env.get(...)` in AdonisJS). */
export type ConsoleSecret = string | { release(): string };

/**
 * The HMAC key every command and answer is authenticated with, derived from the shared secret
 * (at least 16 characters). Throws on a missing or short secret.
 */
export function consoleMacKey(secret: ConsoleSecret, prefix: string): Buffer {
  const raw = typeof secret === 'string' ? secret : secret?.release?.();
  if (typeof raw !== 'string' || raw.length < 16) {
    throw new Error(`[${PACKAGE}] the console channel secret must be at least 16 characters`);
  }
  return createHmac('sha256', raw)
    .update(`agora:${CONSOLE_TOPIC}:console-commands:${prefix}`)
    .digest();
}

/** Deterministic JSON (object keys sorted, `undefined` members dropped): what the MAC covers. */
function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
  }
  throw new Error(`[${PACKAGE}] cannot canonicalize ${typeof value}`);
}

function macOf(key: Buffer, kind: 'command' | 'reply', body: unknown): string {
  return createHmac('sha256', key)
    .update(`${CONSOLE_TOPIC}-console:${kind}\n${canonicalJson(body)}`)
    .digest('base64url');
}

function macMatches(key: Buffer, kind: 'command' | 'reply', body: unknown, mac: unknown): boolean {
  if (typeof mac !== 'string') return false;
  let expected: Buffer;
  try {
    expected = Buffer.from(macOf(key, kind, body));
  } catch {
    return false;
  }
  const actual = Buffer.from(mac);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/** `value` as it will look after a JSON round trip (what the other side computes the MAC over). */
function wireShape<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function isIoredis(client: RedisLike): client is IoredisLike {
  return typeof (client as IoredisLike).duplicate === 'function';
}

/** `SET key value PX ttl NX` on either client: `'OK'` for the one caller that wins the key. */
function claimOf(
  client: RedisLike,
): ((key: string, value: string) => Promise<unknown>) | undefined {
  const target =
    typeof client.set === 'function'
      ? client
      : (client as { ioConnection?: { set?: IoredisLike['set'] } }).ioConnection;
  const set = target?.set;
  if (typeof set !== 'function') return undefined;
  return (key, value) => set.call(target, key, value, 'PX', CLAIM_TTL_MS, 'NX');
}

/** A command the owning app refused or failed, or that nobody answered. */
export class ConsoleChannelError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = 'ConsoleChannelError';
    this.code = code;
  }
}

/** Nobody listens on the app's channel, or nobody answered in time. */
export const APP_UNREACHABLE = 'federated-app-unreachable';

export class RedisConsoleChannel {
  readonly prefix: string;
  readonly #client: RedisLike;
  readonly #subscriptions: Array<() => void> = [];
  readonly #handlers = new Map<string, (payload: string) => void>();
  readonly #pending = new Map<string, (reply: ConsoleReply) => void>();
  #subscriber: IoredisSubscriberLike | undefined;
  #replies: Promise<void> | undefined;
  #answering = false;
  #closed = false;
  readonly #key: Buffer | undefined;

  /**
   * `secret` is shared by the console and the owning app (`controlPlane.secret` on the console's
   * `federatedApps` entry, `consoleCommands.secret` on the app). Every command and answer carries an
   * HMAC under it; without it the channel neither sends nor answers commands.
   */
  constructor(options: { client: RedisLike; prefix: string; secret?: ConsoleSecret | undefined }) {
    if (!options.prefix) throw new Error(`[${PACKAGE}] console channel: prefix is required`);
    this.#client = options.client;
    this.prefix = options.prefix;
    this.#key =
      options.secret === undefined ? undefined : consoleMacKey(options.secret, options.prefix);
  }

  /** Whether a shared secret is set (no secret: no command is sent or answered). */
  get authenticated(): boolean {
    return this.#key !== undefined;
  }

  get commandChannel(): string {
    return `${this.prefix}-${CONSOLE_TOPIC}-console`;
  }

  get replyChannel(): string {
    return `${this.prefix}-${CONSOLE_TOPIC}-console-reply`;
  }

  /** Subscribe `handler` to `channel`; resolves once the subscription is in place. */
  async #subscribe(channel: string, handler: (payload: string) => void): Promise<void> {
    const client = this.#client;
    if (isIoredis(client)) {
      if (!this.#subscriber) {
        const sub = client.duplicate();
        this.#subscriber = sub;
        sub.on('message', (ch, payload) => this.#handlers.get(ch)?.(payload));
      }
      this.#handlers.set(channel, handler);
      await this.#subscriber.subscribe(channel);
      return;
    }
    await client.subscribe(channel, handler);
    this.#subscriptions.push(() => void client.unsubscribe?.(channel));
  }

  /**
   * Send `command` to the owning app and wait for its answer. Rejects at once when no instance
   * listens (`PUBLISH` reached nobody) and after `timeoutMs` when nobody answers.
   */
  async send(
    command: ConsoleCommand,
    options: { timeoutMs?: number | undefined } = {},
  ): Promise<ConsoleReply> {
    if (this.#closed) throw new ConsoleChannelError('console channel closed', APP_UNREACHABLE);
    const key = this.#key;
    if (!key) {
      throw new ConsoleChannelError(
        `the "${this.prefix}" console channel has no shared secret: set \`controlPlane.secret\` (the app's \`consoleCommands.secret\`)`,
        APP_UNREACHABLE,
      );
    }
    if (!this.#replies) {
      const replies = this.#subscribe(this.replyChannel, (payload) => {
        try {
          const parsed = JSON.parse(payload) as { v?: unknown; reply?: unknown; mac?: unknown };
          if (parsed?.v !== 1 || !parsed.reply || typeof parsed.reply !== 'object') return;
          // An answer only counts when the owning app signed it with the shared secret.
          if (!macMatches(key, 'reply', [this.prefix, parsed.reply], parsed.mac)) return;
          const reply = parsed.reply as ConsoleReply;
          if (typeof reply.id !== 'string') return;
          this.#pending.get(reply.id)?.(reply);
        } catch {
          // a malformed answer is dropped, never thrown
        }
      });
      this.#replies = replies;
      // A failed subscribe (a Redis blip) is retried by the next send, not kept for good.
      replies.catch(() => {
        if (this.#replies === replies) this.#replies = undefined;
      });
    }
    try {
      await this.#replies;
    } catch (error) {
      throw new ConsoleChannelError(
        `could not subscribe to the "${this.prefix}" app's console replies: ${error instanceof Error ? error.message : String(error)}`,
        APP_UNREACHABLE,
      );
    }
    const timeoutMs = options.timeoutMs ?? CONSOLE_COMMAND_TIMEOUT_MS;
    return new Promise<ConsoleReply>((resolve, reject) => {
      const fail = (message: string) => {
        clearTimeout(timer);
        this.#pending.delete(command.id);
        reject(new ConsoleChannelError(message, APP_UNREACHABLE));
      };
      const timer = setTimeout(
        () =>
          fail(
            `no instance of the "${this.prefix}" app answered the ${CONSOLE_TOPIC} console command ${command.verb} within ${timeoutMs}ms`,
          ),
        timeoutMs,
      );
      timer.unref?.();
      this.#pending.set(command.id, (reply) => {
        clearTimeout(timer);
        this.#pending.delete(command.id);
        resolve(reply);
      });
      const body = wireShape(command);
      const ts = Date.now();
      const envelope = {
        v: 1,
        ts,
        command: body,
        mac: macOf(key, 'command', [this.prefix, ts, body]),
      };
      this.#client.publish(this.commandChannel, JSON.stringify(envelope)).then(
        (receivers) => {
          // Redis says how many subscribers got it: none means no instance answers commands.
          if (receivers === 0) {
            fail(
              `no instance of the "${this.prefix}" app listens for ${CONSOLE_TOPIC} console commands (is it up, with \`consoleCommands\` in config/${CONSOLE_TOPIC}.ts?)`,
            );
          }
        },
        (err: unknown) => fail(err instanceof Error ? err.message : String(err)),
      );
    });
  }

  /**
   * Answer the commands other apps' consoles send this app. Every instance subscribes; the one that
   * wins `SET <prefix>-<topic>-console-claim:<id> NX` runs the command and publishes the answer, so
   * a command runs once however many processes the app has. Throws when the client cannot run that
   * `SET`: a command never runs without the claim.
   */
  async answer(
    handler: (command: ConsoleCommand) => Promise<unknown>,
    options: { onError?: (error: unknown) => void } = {},
  ): Promise<void> {
    if (this.#answering) return;
    const key = this.#key;
    if (!key) {
      throw new Error(
        `the "${this.prefix}" console channel has no shared secret: set \`consoleCommands.secret\` (the console's \`controlPlane.secret\`); refusing to answer unauthenticated commands`,
      );
    }
    const claim = claimOf(this.#client);
    if (!claim) {
      throw new Error(
        `the "${this.prefix}" Redis connection cannot run \`SET key value PX ms NX\`, so ${CONSOLE_TOPIC} console commands cannot be claimed by one instance; refusing to answer them`,
      );
    }
    this.#answering = true;
    const instance = randomUUID();
    await this.#subscribe(this.commandChannel, (payload) => {
      void this.#run(payload, key, instance, claim, handler).catch((error) =>
        options.onError?.(error),
      );
    });
  }

  /**
   * The command in `payload` when it is authentic and fresh: signed with the shared secret, and
   * stamped within {@link CONSOLE_COMMAND_MAX_AGE_MS} of now. Anything else is `undefined`.
   */
  #verify(payload: string, key: Buffer): ConsoleCommand | undefined {
    try {
      const parsed = JSON.parse(payload) as {
        v?: unknown;
        ts?: unknown;
        command?: unknown;
        mac?: unknown;
      };
      if (parsed?.v !== 1 || typeof parsed.ts !== 'number' || !Number.isFinite(parsed.ts)) {
        return undefined;
      }
      if (Math.abs(Date.now() - parsed.ts) > CONSOLE_COMMAND_MAX_AGE_MS) return undefined;
      if (!parsed.command || typeof parsed.command !== 'object') return undefined;
      if (!macMatches(key, 'command', [this.prefix, parsed.ts, parsed.command], parsed.mac)) {
        return undefined;
      }
      return parsed.command as ConsoleCommand;
    } catch {
      return undefined;
    }
  }

  async #run(
    payload: string,
    key: Buffer,
    instance: string,
    claim: (key: string, value: string) => Promise<unknown>,
    handler: (command: ConsoleCommand) => Promise<unknown>,
  ): Promise<void> {
    const command = this.#verify(payload, key);
    if (!command) return;
    if (typeof command.id !== 'string' || command.id === '' || typeof command.verb !== 'string') {
      return;
    }
    const claimed = await claim(
      `${this.prefix}-${CONSOLE_TOPIC}-console-claim:${command.id}`,
      instance,
    );
    if (claimed !== 'OK') return;
    let reply: ConsoleReply;
    try {
      const data = await handler({
        ...command,
        args: Array.isArray(command.args) ? command.args : [],
        ...(Array.isArray(command.capabilities)
          ? { capabilities: command.capabilities.filter((c) => typeof c === 'string') }
          : {}),
      });
      // `undefined` (an action with no answer) travels as `null`.
      reply = { id: command.id, ok: true, data: data === undefined ? null : data };
    } catch (err) {
      const { code, status } = (err ?? {}) as { code?: unknown; status?: unknown };
      reply = {
        id: command.id,
        ok: false,
        error: {
          message: err instanceof Error ? err.message : String(err),
          ...(typeof code === 'string' ? { code } : {}),
          ...(typeof status === 'number' ? { status } : {}),
        },
      };
    }
    const body = wireShape(reply);
    await this.#client.publish(
      this.replyChannel,
      JSON.stringify({ v: 1, reply: body, mac: macOf(key, 'reply', [this.prefix, body]) }),
    );
  }

  /** Stop listening and fail the commands still waiting for an answer. */
  async close(): Promise<void> {
    this.#closed = true;
    for (const [id, settle] of this.#pending) {
      settle({
        id,
        ok: false,
        error: { message: 'console channel closed', code: APP_UNREACHABLE },
      });
    }
    this.#pending.clear();
    for (const unsubscribe of this.#subscriptions.splice(0)) unsubscribe();
    this.#subscriber?.disconnect?.();
    this.#subscriber = undefined;
  }
}

/**
 * The Redis client for `connection` (an `@adonisjs/redis` connection name; omit for its default),
 * resolved through the container's `redis` binding.
 */
export async function resolveRedisConnection(
  container: { make(binding: string): Promise<unknown> },
  connection: string | undefined,
): Promise<RedisLike> {
  let redis: { connection(name?: string): unknown };
  try {
    redis = (await container.make('redis')) as typeof redis;
  } catch (error) {
    throw new Error(
      `[${PACKAGE}] the federated console needs @adonisjs/redis (no "redis" binding: ${error instanceof Error ? error.message : String(error)})`,
    );
  }
  return redis.connection(connection) as RedisLike;
}

/** The connection names of `config/redis.ts`, or `undefined` without one. */
export function redisConnectionsOf(config: {
  get<T>(key: string, fallback?: T): T;
}): { names: string[]; default: string | undefined } | undefined {
  const redis = config.get<
    { connection?: unknown; connections?: Record<string, unknown> } | undefined
  >('redis', undefined);
  if (!redis || typeof redis !== 'object' || !redis.connections) return undefined;
  return {
    names: Object.keys(redis.connections),
    default: typeof redis.connection === 'string' ? redis.connection : undefined,
  };
}
