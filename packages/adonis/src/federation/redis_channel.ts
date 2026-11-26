import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { resolveTenantToken, type TenantTokenSource } from '@adonis-agora/crypto-core';
import { type OkpJwk, sealTo } from '../crypto-kit/index.js';
import {
  resolveTenantVerifier,
  type TenantVerifierInput,
  type VerifiedTenant,
} from '../topology/verify.js';

/**
 * The Redis channel a federated console talks to another app over: the console publishes a command
 * on `<prefix>-<topic>-console`, every instance of the owning app hears it, the one that wins
 * `SET <prefix>-<topic>-console-claim:<id> NX PX` runs it, and the answer comes back on
 * `<prefix>-<topic>-console-reply`. The same design as `@adonis-agora/durable`'s and
 * `@adonis-agora/media`'s console commands, on channels of its own, so all of them can share an
 * app's prefix. The same channel as `@adonis-agora/config`'s (the authentication modes too), with
 * {@link CONSOLE_TOPIC}, the JSON canonicalization and the token-mode key of this package.
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
  /** When it was sent (ms since the epoch): a signed command older than a minute is refused. */
  ts?: number;
  /** HMAC of every field above under the pair's shared secret (set by {@link RedisConsoleChannel}). */
  mac?: string;
  /**
   * Token mode: who the owning app verified the console as (its token's partition and
   * capabilities). Set by the channel after verification, never taken from the wire.
   */
  verified?: Pick<VerifiedTenant, 'partition' | 'capabilities' | 'clientId'> & {
    /**
     * An authkit app-call token (audience `urn:agora:app:<this app>`): the audience already binds
     * it to this app, so its `partition` is the CALLER (the console's app), not the target.
     */
    appCall?: boolean;
  };
}

/** The owning app's answer to a {@link ConsoleCommand}. */
export type ConsoleReply = (
  | { id: string; ok: true; data: unknown }
  | { id: string; ok: false; error: { message: string; code?: string; status?: number } }
) & { mac?: string };

/** JSON with object keys sorted at every level, so both sides MAC the same bytes. */
function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(item as Record<string, unknown>).sort()) {
      sorted[key] = (item as Record<string, unknown>)[key];
    }
    return sorted;
  });
}

/** How far a command's `ts` may be from this clock (and so how long a replay could live). */
const MAX_COMMAND_SKEW_MS = 60_000;

/** A shared secret: a string, or a Secret-like object (`env.get('X')` in AdonisJS). */
export type ChannelSecret = string | { release(): string };

/**
 * Signs and checks the messages of one channel. Anyone who can publish on the Redis channel can
 * otherwise send a command (with any actor and capabilities) or answer one (a forged answer would
 * show the console a key operation that never happened): both sides share `secret`, and every
 * command and reply carries an HMAC over its fields, bound to this channel's prefix.
 */
class ChannelSigner {
  readonly #key: Buffer;
  constructor(secret: ChannelSecret, prefix: string) {
    const raw = typeof secret === 'string' ? secret : secret.release();
    if (typeof raw !== 'string' || raw.length < 16) {
      throw new Error(
        `[${PACKAGE}] console channel: the shared secret must be at least 16 characters`,
      );
    }
    this.#key = createHmac('sha256', raw)
      .update(`agora:console-commands:${CONSOLE_TOPIC}:${prefix}`)
      .digest();
  }

  #mac(kind: 'command' | 'reply', fields: unknown): string {
    return createHmac('sha256', this.#key)
      .update(`${kind}\n${canonicalJson(fields)}`)
      .digest('base64url');
  }

  #equal(a: string, b: unknown): boolean {
    if (typeof b !== 'string') return false;
    const left = Buffer.from(a);
    const right = Buffer.from(b);
    return left.length === right.length && timingSafeEqual(left, right);
  }

  #commandFields(command: ConsoleCommand) {
    return [
      command.id,
      command.verb,
      command.args ?? [],
      command.actor ?? null,
      command.capabilities ?? null,
      command.via ?? null,
      command.ts ?? null,
    ];
  }

  #replyFields(reply: ConsoleReply) {
    return [reply.id, reply.ok, reply.ok ? (reply.data ?? null) : reply.error];
  }

  signCommand(command: ConsoleCommand): ConsoleCommand {
    const stamped = { ...command, ts: Date.now() };
    delete stamped.mac;
    return { ...stamped, mac: this.#mac('command', this.#commandFields(stamped)) };
  }

  verifyCommand(command: ConsoleCommand): boolean {
    if (typeof command.ts !== 'number' || Math.abs(Date.now() - command.ts) > MAX_COMMAND_SKEW_MS) {
      return false;
    }
    return this.#equal(this.#mac('command', this.#commandFields(command)), command.mac);
  }

  signReply(reply: ConsoleReply): ConsoleReply {
    const { mac: _mac, ...rest } = reply;
    return {
      ...rest,
      mac: this.#mac('reply', this.#replyFields(rest as ConsoleReply)),
    } as ConsoleReply;
  }

  verifyReply(reply: ConsoleReply): boolean {
    return this.#equal(this.#mac('reply', this.#replyFields(reply)), reply.mac);
  }
}

/** The owning app refused the console's token (the console drops its cached token). */
export const UNAUTHORIZED_CONSOLE = 'federated-console-unauthorized';

/** What one sent command needs from the channel's authentication. */
interface OutgoingMessage {
  wire: unknown;
  verifyReply(reply: ConsoleReply): boolean;
}

/** A command that arrived, once its authentication is checked. */
interface IncomingMessage {
  /** The command to run, or `undefined` when it must be refused with `error`. */
  command?: ConsoleCommand;
  error?: { message: string; code: string; status: number };
  id: string;
  signReply(reply: ConsoleReply): ConsoleReply;
}

interface ChannelAuth {
  /** The mode this receiver accepts, as the refusal reason names it. */
  readonly label?: string;
  wrap?(command: ConsoleCommand): Promise<OutgoingMessage>;
  unwrap?(wire: Record<string, unknown>): Promise<IncomingMessage | null>;
  unauthorized?(): void;
}

function sameMac(expected: string, actual: unknown): boolean {
  if (typeof actual !== 'string') return false;
  const left = Buffer.from(expected);
  const right = Buffer.from(actual);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** How an incoming wire message is authenticated, for a refusal that names it. */
function modeOf(wire: Record<string, unknown>): string {
  if (typeof wire.sealed === 'string') {
    return wire.sealed.startsWith('agora:pk1:') ? 'token' : 'crypto';
  }
  if (typeof wire.mac === 'string') return 'secret';
  return 'unsigned';
}

function fresh(ts: unknown): boolean {
  return typeof ts === 'number' && Math.abs(Date.now() - ts) <= MAX_COMMAND_SKEW_MS;
}

/** Shared-secret mode: both sides hold the same secret and HMAC every command and reply. */
class SecretAuth implements ChannelAuth {
  readonly label = 'secret';
  readonly #signer: ChannelSigner;
  constructor(secret: ChannelSecret, prefix: string) {
    this.#signer = new ChannelSigner(secret, prefix);
  }

  async wrap(command: ConsoleCommand): Promise<OutgoingMessage> {
    return {
      wire: this.#signer.signCommand(command),
      verifyReply: (reply) => this.#signer.verifyReply(reply),
    };
  }

  async unwrap(wire: Record<string, unknown>): Promise<IncomingMessage | null> {
    if (typeof wire.mac !== 'string') return null;
    const command = wire as unknown as ConsoleCommand;
    if (typeof command.id !== 'string' || typeof command.verb !== 'string') return null;
    // Unsigned, stale (over a minute) or tampered: not from the console that holds the secret. A
    // replay inside the window reuses the id, and the claim (kept 2 minutes) refuses it.
    if (!fresh(command.ts)) throw refuse('stale');
    if (!this.#signer.verifyCommand(command)) throw refuse('bad signature');
    const { mac: _mac, ts: _ts, verified: _verified, ...fields } = command;
    return {
      id: command.id,
      command: fields,
      signReply: (reply) => this.#signer.signReply(reply),
    };
  }
}

/**
 * How a sealed command is encrypted: to the public half of the app's own X25519 command key (token
 * mode), or with a symmetric key of a crypto server (the Hub's, a separate crypto app's, or the
 * app's own). Either way only the owning app opens it, and the AAD binds it to this channel and this
 * command id.
 */
export interface ConsoleSealer {
  /** Whether `sealed` is this sealer's ciphertext (so the app knows which one opens it). */
  owns(sealed: string): boolean;
  seal(plaintext: string, aad: string): Promise<string>;
  open(sealed: string, aad: string): Promise<string>;
}

/** The `encrypt`/`decrypt` pair `@adonis-agora/crypto` exposes (a crypto client, `serviceCipher`). */
export interface ConsoleCipher {
  encrypt(input: {
    key: string;
    plaintext: string;
    aad?: string;
    context?: string;
  }): Promise<{ ciphertext: string }>;
  decrypt(input: {
    key: string;
    ciphertext: string;
    aad?: string;
    context?: string;
  }): Promise<{ plaintext: string }>;
}

/**
 * A cipher, or a function returning one: `config/crypto.ts` is read before the crypto runtime is
 * built, so `() => serviceCipher(crypto.service, 'app')` (or a client of another crypto server)
 * defers it to the first command.
 */
export type ConsoleCipherSource = ConsoleCipher | (() => ConsoleCipher | Promise<ConsoleCipher>);

/**
 * Crypto mode: the cipher (an `@adonis-agora/crypto` client, `serviceCipher`, or any service with
 * `encrypt`/`decrypt` — AWS KMS, Vault transit, an HSM wrapper), the key name, and — for a
 * cipher whose ciphertext is not `agora:ct1:<key>:…` — `owns`, which tells this key's ciphertext
 * apart (the app tries each accepted mode in turn).
 */
export interface ConsoleCryptoOptions {
  cipher: ConsoleCipherSource;
  key?: string | undefined;
  owns?: ((ciphertext: string) => boolean) | undefined;
}

/** How long a console waits before minting a failed optional token again. */
const TOKEN_RETRY_MS = 5 * 60_000;

interface TokenOptions {
  tokenOptional?: boolean;
  onTokenUnavailable?: (reason: string) => void;
  tokenHint?: string;
}

/** An authkit app-call verifier: `authkit.appCallerVerifier().verifyToken`. */
export type AppCallVerifier = (
  token: string,
) => Promise<{ app: string; capabilities: string[]; clientId?: string | undefined } | null>;

/** Whether a sealed command must carry a token the app verifies. */
export type CommandTokenRule = 'required' | 'optional' | 'none';

/**
 * The crypto key console commands are sealed with in crypto mode, unless another is named:
 * `console-<lib>`, the same scheme as every Agora lib: an app opens the `console-*` keys of its own
 * partition without a grant, and one seal grant `crypto:seal:console-*` covers them all.
 */
export const CONSOLE_CRYPTO_KEY = `console-${CONSOLE_TOPIC}`;

/**
 * Seals with a crypto key: whoever may `encrypt` with it sends, the app opens. Only `agora:ct1`
 * ciphertexts (a symmetric `aes256-gcm` key) are taken: anyone can encrypt to an X25519 key's public
 * half, so such a key would authenticate nobody.
 */
export function cryptoConsoleSealer(options: ConsoleCryptoOptions): ConsoleSealer {
  const key = options.key ?? CONSOLE_CRYPTO_KEY;
  const source = options.cipher;
  const cipher = async (): Promise<ConsoleCipher> => {
    const resolved = typeof source === 'function' ? await source() : source;
    if (
      !resolved ||
      typeof resolved.encrypt !== 'function' ||
      typeof resolved.decrypt !== 'function'
    ) {
      throw new Error(
        `[${PACKAGE}] console channel: \`crypto.cipher\` is not ready (is the crypto runtime booted?)`,
      );
    }
    return resolved;
  };
  return {
    // `agora:ct1:<key>:<version>:…`: only this key's ciphertext is taken as a crypto command,
    // unless the cipher is another service whose format `owns` recognizes.
    owns: options.owns ?? ((sealed) => sealed.startsWith(`agora:ct1:${key}:`)),
    async seal(plaintext, aad) {
      const { ciphertext } = await (await cipher()).encrypt({ key, plaintext, aad, context: aad });
      return ciphertext;
    },
    async open(sealed, aad) {
      const { plaintext } = await (await cipher()).decrypt({
        key,
        ciphertext: sealed,
        aad,
        context: aad,
      });
      return plaintext;
    },
  };
}

/** Seals to the app's X25519 command key: the console side (public key from the app's store). */
export function appKeySealerTo(recipient: () => Promise<OkpJwk>): ConsoleSealer {
  return {
    owns: (sealed) => sealed.startsWith('agora:pk1:'),
    seal: async (plaintext, aad) => sealTo(await recipient(), plaintext, { aad }),
    open: async () => {
      throw new Error('the console side cannot open commands');
    },
  };
}

/** The key that MACs the replies to one command: a secret only the console and the app know. */
function replyKey(secret: string, prefix: string, id: string): Buffer {
  return createHmac('sha256', Buffer.from(secret, 'base64url'))
    .update(`agora:console-reply:${CONSOLE_TOPIC}:${prefix}:${id}`)
    .digest();
}

function replyMac(key: Buffer, reply: ConsoleReply): string {
  const fields = [reply.id, reply.ok, reply.ok ? (reply.data ?? null) : reply.error];
  return createHmac('sha256', key)
    .update(`reply\n${canonicalJson(fields)}`)
    .digest('base64url');
}

const commandAad = (prefix: string, id: string) =>
  JSON.stringify(['agora:console-command', CONSOLE_TOPIC, prefix, id]);

/**
 * Sealed mode (console side): the whole command, with the console's token when it has one, travels
 * sealed so only the owning app opens it. A Redis reader sees an id and ciphertext: no token to
 * lift and replay, no command to alter. The sealed payload also carries a one-off secret the app
 * MACs its answer with, so a forged answer (from someone who cannot open the command) is ignored.
 */
class SealedSenderAuth implements ChannelAuth {
  readonly #token: ReturnType<typeof resolveTenantToken> | undefined;
  readonly #optional: TokenOptions;
  /** While a failed optional token is not retried (5 minutes after the failure). */
  #skipTokenUntil = 0;
  constructor(
    readonly sealer: ConsoleSealer,
    token: TenantTokenSource | undefined,
    readonly prefix: string,
    optional: TokenOptions = {},
  ) {
    this.#token = token === undefined ? undefined : resolveTenantToken(token);
    this.#optional = optional;
  }

  async #tokenFor(): Promise<string | undefined> {
    if (!this.#token) return undefined;
    if (!this.#optional.tokenOptional) {
      try {
        return await this.#token.get();
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(
          this.#optional.tokenHint ? `${reason}. ${this.#optional.tokenHint}` : reason,
        );
      }
    }
    // Crypto mode: the token is optional, so a failing one never blocks the command.
    if (Date.now() < this.#skipTokenUntil) return undefined;
    try {
      return await this.#token.get();
    } catch (error) {
      this.#skipTokenUntil = Date.now() + TOKEN_RETRY_MS;
      try {
        this.#optional.onTokenUnavailable?.(error instanceof Error ? error.message : String(error));
      } catch {}
      return undefined;
    }
  }

  async wrap(command: ConsoleCommand): Promise<OutgoingMessage> {
    const token = await this.#tokenFor();
    const secret = randomBytes(32).toString('base64url');
    const { mac: _mac, verified: _verified, ...fields } = command;
    const sealed = await this.sealer.seal(
      JSON.stringify({
        command: { ...fields, ts: Date.now() },
        ...(token !== undefined ? { token } : {}),
        replySecret: secret,
      }),
      commandAad(this.prefix, command.id),
    );
    const key = replyKey(secret, this.prefix, command.id);
    return {
      wire: { id: command.id, sealed },
      verifyReply: (reply) => sameMac(replyMac(key, reply), reply.mac),
    };
  }

  unauthorized(): void {
    this.#token?.reset?.();
  }
}

/**
 * Sealed mode (owning app side): open, check freshness, and — when `verifyTenant` is set — verify
 * the token the command carries. With a token the command's app and capabilities come from it; a
 * command without one is accepted only when no `verifyTenant` is set (crypto mode: whoever may
 * encrypt with the key is the console, like a shared secret).
 */
class SealedReceiverAuth implements ChannelAuth {
  readonly label: string;
  readonly #verify: ReturnType<typeof resolveTenantVerifier> | undefined;
  readonly #verifyAppCall: AppCallVerifier | undefined;
  readonly #rule: CommandTokenRule;
  constructor(
    readonly sealer: ConsoleSealer,
    check: {
      verifyTenant?: TenantVerifierInput | undefined;
      verifyAppCall?: AppCallVerifier | undefined;
      rule: CommandTokenRule;
    },
    readonly prefix: string,
    label = 'crypto',
  ) {
    this.label = label;
    this.#verify =
      check.verifyTenant === undefined ? undefined : resolveTenantVerifier(check.verifyTenant);
    this.#verifyAppCall = check.verifyAppCall;
    this.#rule = check.rule;
  }

  /** The token's holder: an authkit app-call token first (audience-bound), else a tenant token. */
  async #verified(
    token: string,
    claimed: string | undefined,
  ): Promise<NonNullable<ConsoleCommand['verified']> | null> {
    if (this.#verifyAppCall) {
      const caller = await this.#verifyAppCall(token).catch(() => null);
      if (caller) {
        return {
          partition: caller.app,
          capabilities: Array.isArray(caller.capabilities) ? caller.capabilities : [],
          clientId: caller.clientId ?? caller.app,
          appCall: true,
        };
      }
    }
    if (!this.#verify) return null;
    const verified = await this.#verify({
      token,
      app: claimed,
      partition: claimed,
      tenant: claimed,
      headers: {},
    });
    if (!verified) return null;
    return {
      partition: verified.partition,
      capabilities: verified.capabilities,
      ...(verified.clientId !== undefined ? { clientId: verified.clientId } : {}),
    };
  }

  async unwrap(wire: Record<string, unknown>): Promise<IncomingMessage | null> {
    if (typeof wire.sealed !== 'string' || typeof wire.id !== 'string') return null;
    if (!this.sealer.owns(wire.sealed)) return null;
    const id = wire.id;
    let payload: { command?: ConsoleCommand; token?: unknown; replySecret?: unknown };
    try {
      payload = JSON.parse(
        await this.sealer.open(wire.sealed, commandAad(this.prefix, id)),
      ) as typeof payload;
    } catch {
      throw refuse("did not open with this app's key");
    }
    const command = payload?.command;
    if (
      !command ||
      command.id !== id ||
      typeof command.verb !== 'string' ||
      typeof payload.replySecret !== 'string'
    ) {
      throw refuse('no command id');
    }
    if (!fresh(command.ts)) throw refuse('stale');
    const key = replyKey(payload.replySecret, this.prefix, id);
    const signReply = (reply: ConsoleReply): ConsoleReply => {
      const { mac: _mac, ...rest } = reply;
      return { ...rest, mac: replyMac(key, rest as ConsoleReply) } as ConsoleReply;
    };
    const { mac: _mac, ts: _ts, verified: _claimed, ...fields } = command;
    const hasToken = typeof payload.token === 'string' && payload.token !== '';
    // No token check at all, or an optional one and no token: the seal is the authentication.
    if (this.#rule === 'none' || (this.#rule === 'optional' && !hasToken)) {
      return { id, signReply, command: fields };
    }

    const target = (command.args?.[0] as { partition?: unknown } | undefined)?.partition;
    const claimed = typeof target === 'string' ? target : undefined;
    let verified: NonNullable<ConsoleCommand['verified']> | null = null;
    try {
      verified = hasToken ? await this.#verified(payload.token as string, claimed) : null;
    } catch {
      verified = null;
    }
    if (!verified) {
      return {
        id,
        signReply,
        error: {
          message: `the console's token was refused by the "${this.prefix}" app`,
          code: UNAUTHORIZED_CONSOLE,
          status: 401,
        },
      };
    }
    return { id, signReply, command: { ...fields, verified } };
  }
}

/** How one channel authenticates: what it sends with, and every way it accepts commands. */
export interface ConsoleChannelAuthOptions {
  /** Shared-secret mode: the same value on the console and on the app (16+ characters). */
  secret?: ChannelSecret | undefined;
  /**
   * Sealed with a crypto key, both sides: the cipher (`serviceCipher(crypto.service, partition)`
   * where the crypto server is in process, or a client of another crypto server) and the key
   * (`console-crypto` by default, `aes256-gcm`). The console needs `encrypt` on it, the app `decrypt`.
   */
  crypto?: ConsoleCryptoOptions | undefined;
  /** Console side: the token each command carries (`authkitTenantToken(...)`). */
  token?: TenantTokenSource | undefined;
  /**
   * Console side, with `crypto`: the token is optional (the app checks it when one comes), so a
   * token that cannot be minted sends the command crypto-only, reports it through
   * `onTokenUnavailable` and is tried again 5 minutes later.
   */
  tokenOptional?: boolean | undefined;
  onTokenUnavailable?: ((reason: string) => void) | undefined;
  /** Console side: appended to a required token's failure (what to grant). */
  tokenHint?: string | undefined;
  /** Console side, without `crypto`: the app's command public key (from the app's own store). */
  recipient?: (() => Promise<OkpJwk>) | undefined;
  /**
   * App side, token mode: opens commands sealed to this app's X25519 command key (its own crypto
   * service decrypts with the `console-commands` key). Used only with a verifier.
   */
  opener?: ConsoleSealer | undefined;
  /** App side: verifies the console's token (`authkitTenantVerifier(...)`). */
  verifyTenant?: TenantVerifierInput | undefined;
  /** App side: verifies an authkit app-call token (`appCallerVerifier().verifyToken`). */
  verifyAppCall?: AppCallVerifier | undefined;
  /**
   * App side, crypto commands: whether they must carry a token. Default `required` when a verifier
   * is set, else `none`; `optional` verifies a token when one comes and accepts the seal alone.
   */
  cryptoToken?: CommandTokenRule | undefined;
}

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
/** How many command ids an instance remembers to recognize a replay of its own. */
const MAX_RAN_IDS = 10_000;

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
  /** Why the owning app refused an incoming command (the uniform `refused a command (<reason>)`). */
  readonly reason: string | undefined;
  constructor(message: string, code: string, reason?: string) {
    super(message);
    this.name = 'ConsoleChannelError';
    this.code = code;
    this.reason = reason;
  }
}

/** Refuses an incoming command with one of the uniform reasons. */
function refuse(reason: string): ConsoleChannelError {
  return new ConsoleChannelError(
    `refused a ${CONSOLE_TOPIC} console command (${reason})`,
    UNSIGNED_CHANNEL,
    reason,
  );
}

/** Nobody listens on the app's channel, or nobody answered in time. */
export const APP_UNREACHABLE = 'federated-app-unreachable';
/** The channel has no shared secret, so it neither sends nor answers commands. */
export const UNSIGNED_CHANNEL = 'federated-channel-unsigned';

export class RedisConsoleChannel {
  readonly prefix: string;
  readonly #client: RedisLike;
  readonly #subscriptions: Array<() => void> = [];
  readonly #handlers = new Map<string, (payload: string) => void>();
  /** `trusted`: settled locally (the channel closing), so no MAC to check. */
  readonly #pending = new Map<string, (reply: ConsoleReply, trusted?: boolean) => void>();
  #subscriber: IoredisSubscriberLike | undefined;
  #replies: Promise<void> | undefined;
  #answering = false;
  #onRefused: ((reason: string) => void) | undefined;
  /** The command ids this instance ran, while their claim lives (bounded), to name a replay. */
  readonly #ran = new Map<string, number>();

  #remember(id: string): void {
    const now = Date.now();
    for (const [ran, at] of this.#ran) {
      if (now - at < CLAIM_TTL_MS && this.#ran.size < MAX_RAN_IDS) break;
      this.#ran.delete(ran);
    }
    this.#ran.set(id, now);
  }

  #ranRecently(id: string): boolean {
    const at = this.#ran.get(id);
    return at !== undefined && Date.now() - at < CLAIM_TTL_MS;
  }
  #closed = false;
  /** How commands are sent (one mode). */
  readonly #sender: ChannelAuth | undefined;
  /** How commands are accepted (each configured mode; an app may accept both while migrating). */
  readonly #receivers: ChannelAuth[];

  /**
   * Redis is not a trust boundary, so a channel neither sends nor answers commands without one of:
   *
   * - `crypto` — commands sealed with a crypto key (the console may encrypt with it,
   *   the app decrypt), optionally with a `token` the app checks with `verifyTenant`;
   * - a `token` sealed to the app's X25519 command key (`recipient` / `opener`), checked
   *   with `verifyTenant` (authkit, typically);
   * - `secret` — shared by the console and the app (the same value on both sides).
   */
  /** The app this channel reaches, as messages name it (default: the prefix). */
  readonly app: string;

  constructor(
    options: {
      client: RedisLike;
      prefix: string;
      app?: string | undefined;
    } & ConsoleChannelAuthOptions,
  ) {
    if (!options.prefix) throw new Error(`[${PACKAGE}] console channel: prefix is required`);
    this.#client = options.client;
    this.prefix = options.prefix;
    this.app = options.app ?? options.prefix;
    const secret =
      options.secret === undefined ? undefined : new SecretAuth(options.secret, options.prefix);
    const crypto = options.crypto ? cryptoConsoleSealer(options.crypto) : undefined;

    // Sending: crypto when configured, else a token sealed to the app's key, else the secret.
    if (options.token !== undefined && !crypto && !options.recipient) {
      throw new Error(
        `[${PACKAGE}] console channel: a \`token\` needs \`crypto\` or the app's \`recipient\` key`,
      );
    }
    const sendSealer =
      crypto ?? (options.recipient ? appKeySealerTo(options.recipient) : undefined);
    const sealedSender =
      sendSealer && (crypto || options.token !== undefined)
        ? new SealedSenderAuth(sendSealer, options.token, options.prefix, {
            tokenOptional: crypto !== undefined && options.tokenOptional === true,
            ...(options.onTokenUnavailable
              ? { onTokenUnavailable: options.onTokenUnavailable }
              : {}),
            ...(options.tokenHint ? { tokenHint: options.tokenHint } : {}),
          })
        : undefined;
    this.#sender = sealedSender ?? secret;

    // Answering: every configured way. Without crypto, sealed commands need a token check.
    const receivers: ChannelAuth[] = [];
    const hasVerifier = options.verifyTenant !== undefined || options.verifyAppCall !== undefined;
    const verifiers = { verifyTenant: options.verifyTenant, verifyAppCall: options.verifyAppCall };
    if (crypto) {
      const rule = options.cryptoToken ?? (hasVerifier ? 'required' : 'none');
      receivers.push(new SealedReceiverAuth(crypto, { ...verifiers, rule }, options.prefix));
    }
    // Sealed to this app's X25519 key: anyone may read its public half, so a token is required.
    if (options.opener && hasVerifier) {
      receivers.push(
        new SealedReceiverAuth(
          options.opener,
          { ...verifiers, rule: 'required' },
          options.prefix,
          'token',
        ),
      );
    }
    if (secret) receivers.push(secret);
    this.#receivers = receivers;
  }

  /** Whether this channel can send commands (a secret, or a token and the app's key). */
  get signed(): boolean {
    return this.#sender !== undefined;
  }

  #unsigned(): ConsoleChannelError {
    return new ConsoleChannelError(
      `the "${this.prefix}" ${CONSOLE_TOPIC} console channel has no authentication; use a crypto key (\`crypto\` on both sides), authkit (a \`token\` on the console, \`verifyTenant\` on the app) or the same \`secret\` on both`,
      UNSIGNED_CHANNEL,
    );
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
    if (!this.#sender?.wrap) throw this.#unsigned();
    const sender = this.#sender;
    let outgoing: OutgoingMessage;
    try {
      outgoing = await sender.wrap!(command);
    } catch (error) {
      if (error instanceof ConsoleChannelError) throw error;
      throw new ConsoleChannelError(
        `could not prepare the ${CONSOLE_TOPIC} console command for "${this.prefix}": ${error instanceof Error ? error.message : String(error)}`,
        APP_UNREACHABLE,
      );
    }
    if (!this.#replies) {
      const replies = this.#subscribe(this.replyChannel, (payload) => {
        let reply: ConsoleReply;
        try {
          reply = JSON.parse(payload) as ConsoleReply;
        } catch {
          return;
        }
        if (typeof reply?.id !== 'string') return;
        this.#pending.get(reply.id)?.(reply);
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
            `no instance of "${this.app}" answered within ${Math.round(timeoutMs / 100) / 10}s — the app may have refused the command (check its logs, or run \`node ace agora:doctor\` there)`,
          ),
        timeoutMs,
      );
      timer.unref?.();
      this.#pending.set(command.id, (reply, trusted = false) => {
        // A reply without this command's MAC is someone else's (or forged): wait for the real one.
        if (!trusted && !outgoing.verifyReply(reply)) return;
        clearTimeout(timer);
        this.#pending.delete(command.id);
        if (!reply.ok && reply.error.code === UNAUTHORIZED_CONSOLE) sender.unauthorized?.();
        resolve(reply);
      });
      this.#client.publish(this.commandChannel, JSON.stringify(outgoing.wire)).then(
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
    options: {
      onError?: (error: unknown) => void;
      /** A refused command, once per occurrence, with its uniform reason. */
      onRefused?: (reason: string) => void;
    } = {},
  ): Promise<void> {
    if (this.#answering) return;
    this.#onRefused = (reason) => {
      try {
        options.onRefused?.(reason);
      } catch {}
    };
    if (this.#receivers.length === 0) throw this.#unsigned();
    const claim = claimOf(this.#client);
    if (!claim) {
      throw new Error(
        `the "${this.prefix}" Redis connection cannot run \`SET key value PX ms NX\`, so ${CONSOLE_TOPIC} console commands cannot be claimed by one instance; refusing to answer them`,
      );
    }
    this.#answering = true;
    const instance = randomUUID();
    await this.#subscribe(this.commandChannel, (payload) => {
      // Never crash on a bad message: every failure is reported (never thrown) and the message
      // dropped; a failing reporter is swallowed too.
      try {
        void this.#run(payload, instance, claim, handler).catch((error) => {
          // A refusal goes to `onRefused` when given, else to `onError` like any failure.
          if (
            error instanceof ConsoleChannelError &&
            error.reason !== undefined &&
            options.onRefused
          ) {
            this.#onRefused?.(error.reason);
            return;
          }
          try {
            options.onError?.(error);
          } catch {}
        });
      } catch (error) {
        try {
          options.onError?.(error);
        } catch {}
      }
    });
  }

  async #run(
    payload: string,
    instance: string,
    claim: (key: string, value: string) => Promise<unknown>,
    handler: (command: ConsoleCommand) => Promise<unknown>,
  ): Promise<void> {
    let wire: Record<string, unknown>;
    try {
      wire = JSON.parse(payload) as Record<string, unknown>;
    } catch {
      throw refuse('not JSON');
    }
    if (!wire || typeof wire !== 'object' || Array.isArray(wire)) throw refuse('not JSON');
    if (typeof wire.id !== 'string' || wire.id === '') throw refuse('no command id');
    let incoming: IncomingMessage | null = null;
    for (const receiver of this.#receivers) {
      incoming = (await receiver.unwrap?.(wire)) ?? null;
      if (incoming) break;
    }
    if (!incoming) {
      const accepts = [...new Set(this.#receivers.map((r) => r.label ?? 'unknown'))].join(', ');
      throw refuse(
        `mode not accepted here (this app accepts: ${accepts}; the command came as ${modeOf(wire)})`,
      );
    }
    // One instance runs (or refuses) it; a replay inside the freshness window reuses the id, and
    // the claim (kept 2 minutes) refuses it.
    const claimed = await claim(
      `${this.prefix}-${CONSOLE_TOPIC}-console-claim:${incoming.id}`,
      instance,
    );
    if (claimed !== 'OK') {
      // Another instance's claim is the normal case (silent); an id this instance already ran is
      // a replay.
      if (this.#ranRecently(incoming.id)) throw refuse('replayed');
      return;
    }
    this.#remember(incoming.id);
    if (!incoming.command) {
      if (incoming.error?.code === UNAUTHORIZED_CONSOLE) this.#onRefused?.('token refused');
      await this.#client.publish(
        this.replyChannel,
        JSON.stringify(incoming.signReply({ id: incoming.id, ok: false, error: incoming.error! })),
      );
      return;
    }
    const command = incoming.command;
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
      if (code === 'capabilities-required') this.#onRefused?.('capabilities-required');
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
    // MAC'd in its wire form (a `Date` becomes a string, `undefined` fields vanish), or the
    // console would compute another MAC and drop a genuine answer.
    await this.#client.publish(
      this.replyChannel,
      JSON.stringify(incoming.signReply(JSON.parse(JSON.stringify(reply)))),
    );
  }

  /** Stop listening and fail the commands still waiting for an answer. */
  async close(): Promise<void> {
    this.#closed = true;
    for (const [id, settle] of this.#pending) {
      settle(
        {
          id,
          ok: false,
          error: { message: 'console channel closed', code: APP_UNREACHABLE },
        },
        true,
      );
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
