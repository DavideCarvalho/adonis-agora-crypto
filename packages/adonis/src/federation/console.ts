import { randomBytes, randomUUID } from 'node:crypto';
import {
  CryptoError,
  type CryptoKeyType,
  type CryptoKeyView,
  capabilityAllows,
  cryptoScope,
  type RewrapResult,
} from '@adonis-agora/crypto-core';
import { type CryptoPrincipal, CryptoService } from '../crypto/service.js';
import type { Keyring } from '../crypto-kit/index.js';
import { inSchema, type SqlDatabase } from '../sql.js';
import { LucidStore } from '../store/lucid_store.js';
import type { CryptoKeyVersionRecord, CryptoStore } from '../store/store.js';
import {
  APP_UNREACHABLE,
  type ConsoleCommand,
  type ConsoleSecret,
  RedisConsoleChannel,
  type RedisLike,
} from './redis_channel.js';

/**
 * The federated crypto console: one app's console (the Hub's) also shows and manages the keys of
 * apps that run `@adonis-agora/crypto` standalone, each with its own store and its own root key.
 * The console reads an app's key metadata, versions and audit straight from its tables, never the
 * key material, and asks the app itself, over Redis, to run every key operation (create, rotate,
 * change the policy, delete, test, rewrap), which the app audits with the console's viewer as the
 * actor.
 */

/** One other app shown in this console (`console.federatedApps` in config/crypto.ts). */
export interface FederatedCryptoAppConfig {
  /** The name shown in the App picker. Defaults to the key. */
  label?: string | undefined;
  /** That app's partition in its own store (its `app` in config/crypto.ts). Defaults to the key. */
  partition?: string | undefined;
  /**
   * Where that app keeps its keys: a Lucid connection of THIS app (`config/database.ts`) that
   * reaches that app's `crypto_keys`, `crypto_key_versions` and `crypto_audit` tables, and the
   * schema they live in. Only read, and never the `material` column: grant `SELECT` on the other
   * columns only.
   */
  store: { connection?: string | undefined; schema?: string | undefined } | CryptoStore;
  /**
   * Where that app answers (its `consoleCommands` in its config/crypto.ts): the `@adonisjs/redis`
   * connection to publish on, the app's `prefix`, and the `secret` it shares with that app (its
   * `consoleCommands.secret`, at least 16 characters). Every command and answer carries an HMAC
   * under it; an entry that may act (`actions` not `false`) needs it.
   */
  controlPlane:
    | { connection?: string | undefined; prefix: string; secret?: ConsoleSecret | undefined }
    | RedisConsoleChannel;
  /**
   * Send key operations to that app. Default `true`; `false` makes it read-only from here. The app
   * decides too: its `consoleCommands.actions`.
   */
  actions?: boolean | undefined;
  /** How long a command waits for the app to answer, in ms. Default 15 000. */
  timeoutMs?: number | undefined;
}

/** What a federated app's key may look like (it travels in the URL as `?app=`). */
export const FEDERATED_APP_KEY = /^[A-Za-z0-9_.-]{1,64}$/;

/** A request the console answers with `status` (a refused, failed or unreachable app). */
export class FederatedAppError extends Error {
  readonly status: number;
  /** The owning app's own message, for this app's log (a `502` does not show it to the browser). */
  readonly detail: string | undefined;
  constructor(message: string, status: number, detail?: string) {
    super(message);
    this.name = 'FederatedAppError';
    this.status = status;
    this.detail = detail;
  }
}

/** A command this app does not answer (an unknown verb). Answered `501` by the console. */
export const UNSUPPORTED = 'unsupported-request';

/**
 * Checks one `federatedApps` entry at boot, so a misconfigured app fails the boot instead of the
 * first request that picks it.
 */
export function validateFederatedCryptoApp(
  key: string,
  entry: FederatedCryptoAppConfig,
  redisConnections: { names: string[]; default: string | undefined } | undefined,
  options: { requireSecret?: boolean } = {},
): void {
  const fail = (message: string): never => {
    throw new Error(`[@adonis-agora/crypto] console.federatedApps["${key}"]: ${message}`);
  };
  if (!FEDERATED_APP_KEY.test(key)) {
    fail('the key must be 1–64 characters of A-Z, a-z, 0-9, _ . -');
  }
  if (!entry || typeof entry !== 'object') fail('must be an object');
  if (!entry.store || typeof entry.store !== 'object') {
    fail('`store` is required ({ connection, schema })');
  }
  if (entry.partition !== undefined && (typeof entry.partition !== 'string' || !entry.partition)) {
    fail('`partition` must be a non-empty string');
  }
  const plane = entry.controlPlane;
  // Key operations are only sent over an authenticated channel: an entry that may act needs the
  // secret it shares with that app, or the boot fails here naming the line to add.
  if (options.requireSecret && entry?.actions !== false) {
    if (plane instanceof RedisConsoleChannel) {
      if (!plane.authenticated) {
        fail('the RedisConsoleChannel passed as `controlPlane` needs a `secret`');
      }
    } else if (plane && typeof plane === 'object') {
      const raw =
        typeof plane.secret === 'string'
          ? plane.secret
          : typeof plane.secret?.release === 'function'
            ? plane.secret.release()
            : undefined;
      if (typeof raw !== 'string' || raw.length < 16) {
        fail(
          "`controlPlane.secret` is required (at least 16 characters, the same value as that app's `consoleCommands.secret`), or set `actions: false` to keep this app read-only here",
        );
      }
    }
  }
  if (!(plane instanceof RedisConsoleChannel)) {
    if (!plane || typeof plane !== 'object') {
      fail('`controlPlane` is required ({ connection, prefix })');
    }
    if (typeof plane.prefix !== 'string' || plane.prefix.trim() === '') {
      fail("`controlPlane.prefix` must be the other app's `consoleCommands.prefix` (not empty)");
    }
    if (
      plane.connection !== undefined &&
      (typeof plane.connection !== 'string' || plane.connection === '')
    ) {
      fail('`controlPlane.connection` must be a connection name of config/redis.ts');
    }
    if (!redisConnections) {
      fail('the federated console needs @adonisjs/redis (no config/redis.ts found)');
    } else {
      const name = plane.connection ?? redisConnections.default;
      if (name === undefined || !redisConnections.names.includes(name)) {
        fail(
          `\`controlPlane.connection\` "${name ?? '(default)'}" is not a connection of config/redis.ts (${redisConnections.names.join(', ') || 'none'})`,
        );
      }
    }
  }
  if (
    entry.timeoutMs !== undefined &&
    (typeof entry.timeoutMs !== 'number' ||
      !Number.isFinite(entry.timeoutMs) ||
      entry.timeoutMs <= 0)
  ) {
    fail('`timeoutMs` must be a positive number of milliseconds');
  }
}

async function readOnly(): Promise<never> {
  throw new FederatedAppError("another app's keys are changed through that app, not here", 501);
}

function withoutMaterial(version: CryptoKeyVersionRecord): CryptoKeyVersionRecord {
  return { ...version, sealed: '' };
}

/**
 * Another app's store as the console may touch it: key metadata, versions without their material,
 * and the audit trail. Every write throws. The console's own metadata reads are not recorded in
 * that app's audit trail (it cannot write there); every key operation is, by the app itself.
 */
export function readOnlyCryptoStore(store: CryptoStore): CryptoStore {
  return {
    getKey: (partition, name) => store.getKey(partition, name),
    listKeys: (partition) => store.listKeys(partition),
    partitions: () => store.partitions(),
    version: async (partition, name, version) => {
      const found = await store.version(partition, name, version);
      return found ? withoutMaterial(found) : null;
    },
    versions: async (partition, name) =>
      (await store.versions(partition, name)).map(withoutMaterial),
    listAudit: (partition, query) => store.listAudit(partition, query),
    ...(store.seekAudit ? { seekAudit: store.seekAudit.bind(store) } : {}),
    auditCounts: (partition, since) => store.auditCounts(partition, since),
    // A read the console does is not an operation of that app: nothing to record there.
    appendAudit: async () => {},
    createKey: readOnly,
    addVersion: readOnly,
    updateKey: readOnly,
    replaceMaterial: readOnly,
    deleteKey: readOnly,
  };
}

/** A keyring that is never there: the console holds no other app's root key. */
const NO_KEYRING = new Proxy({} as Keyring, {
  get() {
    throw new FederatedAppError("another app's key material is never opened here", 501);
  },
});

/* ------------------------------------------------------------------------------------------- */
/* Key tests: an operation round trip that returns no plaintext, ciphertext or key               */
/* ------------------------------------------------------------------------------------------- */

/** The answer of a key test: which operations ran, and whether they round-tripped. */
export interface KeyTestResult {
  key: string;
  type: CryptoKeyType;
  version: number;
  ok: boolean;
  operations: string[];
}

/** The capabilities a key test needs for a key of `type`. */
export function keyTestCapabilities(name: string, type: CryptoKeyType | undefined): string[] {
  if (type === 'ed25519') return [cryptoScope('sign', name), cryptoScope('verify', name)];
  if (type === 'hmac-sha256') return [cryptoScope('hmac', name)];
  return [cryptoScope('encrypt', name), cryptoScope('decrypt', name)];
}

/**
 * Exercise a key with a random probe: encrypt + decrypt, sign + verify, or two HMACs that must
 * match. Each operation is audited by the service like any other; the probe, the ciphertext and the
 * signature never leave this function.
 */
export async function testKey(
  service: CryptoService,
  principal: CryptoPrincipal,
  name: string,
): Promise<KeyTestResult> {
  const record = await service.store.getKey(principal.partition, name);
  if (!record || record.deletedAt !== undefined) {
    throw new CryptoError('not_found', `crypto: no key named "${name}"`);
  }
  const probe = randomBytes(18).toString('base64url');
  if (record.type === 'ed25519') {
    const signed = await service.sign(principal, { key: name, message: probe });
    const verified = await service.verify(principal, {
      key: name,
      message: probe,
      signature: signed.signature,
    });
    return {
      key: name,
      type: record.type,
      version: record.latestVersion,
      ok: verified.valid,
      operations: ['sign', 'verify'],
    };
  }
  if (record.type === 'hmac-sha256') {
    const first = await service.hmac(principal, { key: name, message: probe });
    const second = await service.hmac(principal, { key: name, message: probe });
    return {
      key: name,
      type: record.type,
      version: record.latestVersion,
      ok: first.hmac === second.hmac,
      operations: ['hmac'],
    };
  }
  const sealed = await service.encrypt(principal, { key: name, plaintext: probe });
  const opened = await service.decrypt(principal, {
    key: name,
    ciphertext: sealed.ciphertext,
    context: 'console:test',
  });
  return {
    key: name,
    type: record.type,
    version: sealed.version,
    ok: opened.plaintext === probe,
    operations: ['encrypt', 'decrypt'],
  };
}

/* ------------------------------------------------------------------------------------------- */
/* The owning app: answering commands                                                          */
/* ------------------------------------------------------------------------------------------- */

/** The key operations another console may ask this app to run. Never `export`. */
export const ACTION_VERBS = [
  'createKey',
  'rotateKey',
  'updateKeyPolicy',
  'deleteKey',
  'testKey',
  'rewrap',
] as const;

export type CryptoConsoleVerb = (typeof ACTION_VERBS)[number];

const ACTIONS: ReadonlySet<string> = new Set(ACTION_VERBS);

/**
 * What another console may do here with `actions: true`, unless `consoleCommands.capabilities`
 * says otherwise: manage keys and test or rewrap with them. Never `crypto:keys:export`.
 */
export const DEFAULT_CONSOLE_CAPABILITIES = [
  'crypto:keys:read',
  'crypto:keys:manage',
  'crypto:encrypt:*',
  'crypto:decrypt:*',
  'crypto:sign:*',
  'crypto:verify:*',
  'crypto:hmac:*',
  'crypto:rewrap:*',
] as const;

class CommandError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
  }
}

/** The error code of a command that carried no viewer capabilities. */
export const CAPABILITIES_REQUIRED = 'capabilities-required';

export interface CryptoConsoleCommandHandlerOptions {
  /** This app's crypto service (its store, its root key, its audit). */
  service: CryptoService;
  /** Run key operations at all. */
  actions: boolean;
  /** What the other console may do here. Default {@link DEFAULT_CONSOLE_CAPABILITIES}. */
  capabilities?: readonly string[] | undefined;
  /** The partitions the other console may touch (`undefined`: any of this store's). */
  partitions?: readonly string[] | undefined;
  log?: ((line: string) => void) | undefined;
}

function text(value: unknown, name: string): string {
  if (typeof value !== 'string' || value === '') {
    throw new CommandError(`crypto: ${name} is required`, 400);
  }
  return value;
}

/**
 * Run the key operations another app's federated console sends this app, through this app's own
 * {@link CryptoService}: the capability check, the audit row (with the other console's viewer as
 * the actor and `console:<label>` as the client) and the material are all this app's. The
 * principal holds what this app allows, narrowed to what the console's `authorize` granted the
 * viewer when it said; the export operation is not a command at all.
 */
export function cryptoConsoleCommandHandler(
  options: CryptoConsoleCommandHandlerOptions,
): (command: ConsoleCommand) => Promise<unknown> {
  const allowed = [...(options.capabilities ?? DEFAULT_CONSOLE_CAPABILITIES)].filter(
    (capability) => !capabilityAllows([capability], 'crypto:keys:export'),
  );
  return async (command) => {
    const { verb } = command;
    if (!ACTIONS.has(verb)) {
      throw Object.assign(
        new Error(`this app does not answer the crypto console command ${verb}`),
        {
          code: UNSUPPORTED,
        },
      );
    }
    if (!options.actions) {
      throw new CommandError(
        'this app does not run key operations from another console (consoleCommands.actions is off)',
        403,
      );
    }
    const body = (command.args[0] ?? {}) as Record<string, unknown>;
    const partition = text(body.partition, 'partition');
    if (options.partitions !== undefined && !options.partitions.includes(partition)) {
      throw new CommandError(
        `crypto: this app does not serve "${partition}" to other consoles`,
        403,
      );
    }
    const name = text(body.name, 'name');
    // The console always sends what its `authorize` granted the viewer: no capabilities, no command.
    const viewer = command.capabilities;
    if (!Array.isArray(viewer)) {
      throw new CommandError(
        'crypto: the console sent no viewer capabilities',
        403,
        CAPABILITIES_REQUIRED,
      );
    }
    const actor =
      typeof command.actor === 'string' && command.actor !== '' ? command.actor : 'console';
    const via = typeof command.via === 'string' && command.via !== '' ? command.via : 'federated';
    // What this app allows, narrowed by the viewer's grant: an operation needs both.
    const principal: CryptoPrincipal = {
      partition,
      capabilities: narrow(allowed, viewer),
      actor,
      clientId: `console:${via}`,
    };
    options.log?.(
      `[crypto] federated console: ${verb} ${partition}/${name} by ${actor} via ${via}`,
    );
    const { service } = options;
    switch (verb as CryptoConsoleVerb) {
      case 'createKey':
        return service.createKey(principal, {
          name,
          type: body.type as CryptoKeyType,
          ...(typeof body.description === 'string' && body.description !== ''
            ? { description: body.description }
            : {}),
          ...(typeof body.deletionAllowed === 'boolean'
            ? { deletionAllowed: body.deletionAllowed }
            : {}),
          ...(typeof body.exportable === 'boolean' ? { exportable: body.exportable } : {}),
        });
      case 'rotateKey':
        return service.rotateKey(principal, name);
      case 'updateKeyPolicy': {
        const patch = (body.patch ?? {}) as Record<string, unknown>;
        return service.updateKeyPolicy(principal, name, {
          ...(patch.description === null || typeof patch.description === 'string'
            ? { description: patch.description as string | null }
            : {}),
          ...(typeof patch.minDecryptionVersion === 'number'
            ? { minDecryptionVersion: patch.minDecryptionVersion }
            : {}),
          ...(typeof patch.deletionAllowed === 'boolean'
            ? { deletionAllowed: patch.deletionAllowed }
            : {}),
          ...(typeof patch.exportable === 'boolean' ? { exportable: patch.exportable } : {}),
        });
      }
      case 'deleteKey':
        return service.deleteKey(principal, name);
      case 'testKey':
        return testKey(service, principal, name);
      case 'rewrap':
        return service.rewrap(principal, {
          key: name,
          ciphertext: text(body.ciphertext, 'ciphertext'),
          ...(typeof body.aad === 'string' ? { aad: body.aad } : {}),
          context: `console:${via}`,
        });
    }
  };
}

/**
 * The capabilities a principal holds when this app allows `allowed` and the console granted the
 * viewer `viewer`: each of the viewer's that this app allows, plus each of this app's that the
 * viewer's cover. Either way an operation needs both to say yes.
 */
function narrow(allowed: readonly string[], viewer: readonly string[]): string[] {
  const out = new Set<string>();
  for (const v of viewer) {
    if (typeof v === 'string' && v !== '' && capabilityAllows(allowed, v)) out.add(v);
  }
  for (const a of allowed) {
    if (capabilityAllows(viewer, a)) out.add(a);
  }
  return [...out];
}

/* ------------------------------------------------------------------------------------------- */
/* The console: another app as it sees it                                                       */
/* ------------------------------------------------------------------------------------------- */

/** What the console sends with a command, besides its arguments. */
export interface CommandMeta {
  actor: string;
  /** The viewer's capabilities (always sent: the owning app refuses a command without them). */
  capabilities: string[];
  via?: string | undefined;
}

/**
 * Another app as the console sees it: a service over its store (key metadata and audit only, no
 * root key) and its command channel for every key operation. Built once per app.
 */
export class FederatedCryptoApp {
  readonly id: string;
  readonly label: string;
  readonly partition: string;
  readonly actions: boolean;
  /** Reads only: keys, versions (no material), overview and audit. */
  readonly service: CryptoService;
  readonly channel: RedisConsoleChannel;
  readonly timeoutMs: number | undefined;

  constructor(options: {
    id: string;
    label?: string | undefined;
    partition?: string | undefined;
    actions?: boolean | undefined;
    store: CryptoStore;
    channel: RedisConsoleChannel;
    timeoutMs?: number | undefined;
  }) {
    this.id = options.id;
    this.label = options.label ?? options.id;
    this.partition = options.partition ?? options.id;
    this.actions = options.actions !== false;
    this.service = new CryptoService({
      store: readOnlyCryptoStore(options.store),
      keyring: NO_KEYRING,
    });
    this.channel = options.channel;
    this.timeoutMs = options.timeoutMs;
  }

  /** The principal the console reads with: key metadata and the audit, nothing else. */
  reader(actor: string): CryptoPrincipal {
    return { partition: this.partition, capabilities: ['crypto:keys:read'], actor };
  }

  /** Send `verb` about key `name` to the app and return its answer; errors become HTTP answers. */
  async send(
    verb: CryptoConsoleVerb,
    name: string,
    args: Record<string, unknown>,
    meta: CommandMeta,
  ): Promise<unknown> {
    if (!this.actions) {
      throw new FederatedAppError(`${this.label} is read-only in this console`, 403);
    }
    let reply: Awaited<ReturnType<RedisConsoleChannel['send']>>;
    try {
      reply = await this.channel.send(
        {
          id: randomUUID(),
          verb,
          args: [{ ...args, partition: this.partition, name }],
          actor: meta.actor,
          capabilities: meta.capabilities,
          ...(meta.via !== undefined ? { via: meta.via } : {}),
        },
        this.timeoutMs !== undefined ? { timeoutMs: this.timeoutMs } : {},
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new FederatedAppError(`${this.label}: ${message}`, 503);
    }
    if (reply.ok) return reply.data;
    const { message, code, status } = reply.error;
    if (code === APP_UNREACHABLE) throw new FederatedAppError(`${this.label}: ${message}`, 503);
    if (code === UNSUPPORTED) throw new FederatedAppError(message, 501);
    // The app's own answer (a refused capability, an unknown key, a bad policy…) stands.
    if (typeof status === 'number' && status >= 400 && status < 500) {
      throw new FederatedAppError(message, status);
    }
    throw new FederatedAppError(`the ${this.label} app answered with an error`, 502, message);
  }

  createKey(input: Record<string, unknown> & { name: string }, meta: CommandMeta) {
    const { name, ...rest } = input;
    return this.send('createKey', name, rest, meta) as Promise<CryptoKeyView>;
  }

  rotateKey(name: string, meta: CommandMeta) {
    return this.send('rotateKey', name, {}, meta) as Promise<CryptoKeyView>;
  }

  updateKeyPolicy(name: string, patch: Record<string, unknown>, meta: CommandMeta) {
    return this.send('updateKeyPolicy', name, { patch }, meta) as Promise<CryptoKeyView>;
  }

  deleteKey(name: string, meta: CommandMeta) {
    return this.send('deleteKey', name, {}, meta) as Promise<{ key: string; deleted: boolean }>;
  }

  testKey(name: string, meta: CommandMeta) {
    return this.send('testKey', name, {}, meta) as Promise<KeyTestResult>;
  }

  rewrap(name: string, input: { ciphertext: string; aad?: string }, meta: CommandMeta) {
    return this.send('rewrap', name, input, meta) as Promise<RewrapResult>;
  }

  async close(): Promise<void> {
    await this.channel.close();
  }
}

/** Build one configured app: its store (metadata only) and its command channel. */
export async function buildFederatedCryptoApp(
  id: string,
  config: FederatedCryptoAppConfig,
  deps: {
    /** A Lucid query client for `connection` (this app's `config/database.ts`). */
    db(connection?: string): Promise<SqlDatabase>;
    /** The Redis client for `connection` (this app's `config/redis.ts`). */
    redis(connection?: string): Promise<RedisLike>;
  },
): Promise<FederatedCryptoApp> {
  const spec = config.store as { connection?: string; schema?: string } | CryptoStore;
  const store: CryptoStore =
    typeof (spec as CryptoStore).getKey === 'function'
      ? (spec as CryptoStore)
      : new LucidStore(
          inSchema(
            await deps.db((spec as { connection?: string }).connection),
            (spec as { schema?: string }).schema,
          ),
          { autoCreateSchema: false, metadataOnly: true },
        );
  const channel =
    config.controlPlane instanceof RedisConsoleChannel
      ? config.controlPlane
      : new RedisConsoleChannel({
          client: await deps.redis(config.controlPlane.connection),
          prefix: config.controlPlane.prefix,
          ...(config.controlPlane.secret !== undefined
            ? { secret: config.controlPlane.secret }
            : {}),
        });
  return new FederatedCryptoApp({
    id,
    label: config.label,
    partition: config.partition,
    actions: config.actions,
    store,
    channel,
    timeoutMs: config.timeoutMs,
  });
}

/** The configured other apps of one console, each built once on first use. */
export class FederatedCryptoApps {
  readonly #specs: Record<string, FederatedCryptoAppConfig>;
  readonly #deps: Parameters<typeof buildFederatedCryptoApp>[2];
  readonly #built = new Map<string, Promise<FederatedCryptoApp>>();

  constructor(
    specs: Record<string, FederatedCryptoAppConfig>,
    deps: Parameters<typeof buildFederatedCryptoApp>[2],
  ) {
    this.#specs = specs;
    this.#deps = deps;
  }

  get ids(): string[] {
    return Object.keys(this.#specs);
  }

  has(id: string): boolean {
    return Object.hasOwn(this.#specs, id);
  }

  /** What the App picker lists for `id`. */
  describe(id: string): { id: string; label: string; mode: 'federated'; actions: 'app' | 'none' } {
    const spec = this.#specs[id];
    return {
      id,
      label: spec?.label ?? id,
      mode: 'federated',
      actions: spec?.actions === false ? 'none' : 'app',
    };
  }

  get(id: string): Promise<FederatedCryptoApp> {
    let app = this.#built.get(id);
    if (!app) {
      const spec = this.#specs[id];
      if (!spec) return Promise.reject(new FederatedAppError('unknown app', 404));
      app = buildFederatedCryptoApp(id, spec, this.#deps).catch((error: unknown) => {
        throw new FederatedAppError(
          `${spec.label ?? id}: the console could not reach this app`,
          503,
          error instanceof Error ? error.message : String(error),
        );
      });
      // A failed build (a bad connection name) is retried on the next request, not cached.
      app.catch(() => this.#built.delete(id));
      this.#built.set(id, app);
    }
    return app;
  }

  async close(): Promise<void> {
    const apps = [...this.#built.values()];
    this.#built.clear();
    await Promise.all(apps.map((app) => app.then((a) => a.close()).catch(() => undefined)));
  }
}
