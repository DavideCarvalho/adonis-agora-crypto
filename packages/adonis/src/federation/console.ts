import { randomBytes, randomUUID } from 'node:crypto';
import {
  CryptoError,
  type CryptoKeyType,
  type CryptoKeyView,
  cryptoScope,
  type RewrapResult,
  type TenantTokenSource,
} from '@adonis-agora/crypto-core';
import { type CryptoPrincipal, CryptoService } from '../crypto/service.js';
import { type Keyring, type OkpJwk, sealedToKid } from '../crypto-kit/index.js';
import { inSchema, type SqlDatabase } from '../sql.js';
import { LucidStore } from '../store/lucid_store.js';
import type { CryptoKeyVersionRecord, CryptoStore } from '../store/store.js';
import {
  CRYPTO_CONSOLE_CAPABILITIES,
  commandCandidates,
  commandRequirement,
  cryptoConsoleAllows,
  viewerConsoleCapabilities,
} from './console_grants.js';
import {
  type AuthkitClientLike,
  appCallGrantHint,
  autoConsoleCipher,
  resolveConsoleSideMode,
} from './console_modes.js';
import {
  APP_UNREACHABLE,
  type ConsoleCommand,
  type ConsoleCryptoOptions,
  type ConsoleSealer,
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
  /**
   * That app's partition in its own store (its `app` in config/crypto.ts). Defaults to the key. In
   * automatic crypto mode it is also the partition of THIS server that holds the `console-crypto`
   * key, so it must be the partition that app is a tenant of here (its crypto client's partition).
   */
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
   * connection to publish on, the app's `prefix`, and how this console proves itself to the app:
   * nothing to add with this console's own crypto server (automatic crypto mode), else `token`,
   * `crypto` or `secret`.
   */
  controlPlane:
    | {
        connection?: string | undefined;
        prefix: string;
        /**
         * Shared-secret mode: the secret shared with that app (its `consoleCommands.secret`). Use it
         * when there is no authkit; otherwise prefer `token`.
         */
        secret?: string | { release(): string } | undefined;
        /**
         * Token mode: this console's token for that app, e.g. `authkitTenantToken({ issuer,
         * clientId, clientSecret, resource: 'urn:agora:crypto' })` of a service-tenant client whose
         * `partition` is that app and whose capabilities say what this console may do there
         * (`crypto:keys:manage`, `crypto:rewrap:*`, …). The app checks it with its
         * `consoleCommands.verifyTenant`. Commands travel sealed to the public half of the app's
         * `console-commands` key, read from the app's store (its `crypto_key_versions.public_key`,
         * which this console already reads), never from Redis. Omitted with
         * @adonis-agora/authkit-client's \`apps\` configured: its app-call token for that app, sent
         * automatically (on top of automatic crypto). \`false\` turns that off.
         */
        token?: TenantTokenSource | false | undefined;
        /**
         * Sealed with a crypto key. Omitted (the default): automatic — this console's own crypto
         * server seals each command with its `console-crypto` key (`aes256-gcm`) in that app's
         * `partition`, created on first use; the app opens it through its client of this server,
         * which needs no grant (an app opens the `console-*` keys of its own partition implicitly). Set `{ cipher, key? }` to seal with another
         * server's key instead (a client of it for that partition), or `false` to turn automatic
         * mode off (then `token` or `secret` is required, or `actions: false`). Ignored as a default
         * when `token` or `secret` is set: explicit options win.
         */
        crypto?: ConsoleCryptoOptions | false | undefined;
      }
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
    if (
      plane.crypto !== undefined &&
      plane.crypto !== false &&
      (typeof plane.crypto !== 'object' ||
        plane.crypto === null ||
        (typeof plane.crypto.cipher !== 'function' && typeof plane.crypto.cipher !== 'object') ||
        (plane.crypto.owns !== undefined && typeof plane.crypto.owns !== 'function'))
    ) {
      fail(
        "`controlPlane.crypto` must be `{ cipher, key?, owns? }` (a crypto client of that partition, or your own KMS cipher), or `false`; leave it out to seal with this server's console-crypto key automatically",
      );
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

/**
 * The X25519 key an owning app opens token-mode commands with, in each partition it serves. Its
 * public half sits in the app's own `crypto_key_versions`, where the console reads it (never from
 * Redis); the private half is sealed by the app's root key like any other key's. Created at boot,
 * rotated with `crypto:keys:rotate console-commands`, and never touched by a console command.
 */
export const CONSOLE_COMMAND_KEY = 'console-commands';

/** The principal the owning app opens token-mode commands with (decrypt on its command key only). */
function commandKeyPrincipal(partition: string): CryptoPrincipal {
  return {
    partition,
    capabilities: [cryptoScope('decrypt', CONSOLE_COMMAND_KEY)],
    actor: 'console-commands',
  };
}

/**
 * Owning app, token mode: make sure each served partition holds the command key (an X25519 key the
 * console seals to). Idempotent; a name taken by a key of another type is reported, not replaced.
 */
export async function ensureConsoleCommandKey(
  service: CryptoService,
  partition: string,
): Promise<'created' | 'present'> {
  const existing = await service.store.getKey(partition, CONSOLE_COMMAND_KEY);
  if (existing) {
    if (existing.type !== 'x25519' || existing.deletedAt !== undefined) {
      throw new Error(
        `"${partition}/${CONSOLE_COMMAND_KEY}" exists but is not a live x25519 key, so token-mode console commands cannot be sealed to it`,
      );
    }
    return 'present';
  }
  try {
    await service.createKey(
      {
        partition,
        capabilities: [`crypto:keys:manage:${CONSOLE_COMMAND_KEY}`],
        actor: 'crypto:console-commands',
      },
      {
        name: CONSOLE_COMMAND_KEY,
        type: 'x25519',
        description: "Seals other consoles' commands to this app (consoleCommands, token mode)",
      },
    );
    return 'created';
  } catch (error) {
    // Another instance created it first.
    if (error instanceof CryptoError && error.code === 'conflict') return 'present';
    throw error;
  }
}

/**
 * Owning app, token mode: opens a command sealed to the command key of one of `partitions`, through
 * this app's own service (each open is a `decrypt` row in its audit trail).
 */
export function commandKeyOpener(
  service: CryptoService,
  partitions: readonly string[],
): ConsoleSealer {
  return {
    owns: (sealed) => sealedToKid(sealed) !== undefined,
    seal: async () => {
      throw new Error('the owning app does not seal console commands');
    },
    async open(sealed, aad) {
      const kid = sealedToKid(sealed);
      for (const partition of partitions) {
        const versions = await service.store.versions(partition, CONSOLE_COMMAND_KEY);
        if (!versions.some((version) => version.kid === kid)) continue;
        const { plaintext } = await service.decrypt(commandKeyPrincipal(partition), {
          key: CONSOLE_COMMAND_KEY,
          ciphertext: sealed,
          aad,
          context: 'console-command',
        });
        return plaintext;
      }
      throw new Error('sealed to no command key of a partition this app serves');
    },
  };
}

/** How long a console trusts the command key it read from an app's store before reading again. */
const COMMAND_KEY_TTL_MS = 5 * 60_000;

/**
 * Console side, token mode: reads the public half of the app's command key from the app's own
 * store (the tables this console already reads; Redis cannot touch them). Cached for a few
 * minutes, so a rotation is picked up after that.
 */
export function commandKeyReader(store: CryptoStore, partition: string): () => Promise<OkpJwk> {
  let cached: { key: OkpJwk; at: number } | undefined;
  return async () => {
    if (cached && Date.now() - cached.at < COMMAND_KEY_TTL_MS) return cached.key;
    const record = await store.getKey(partition, CONSOLE_COMMAND_KEY);
    const version =
      record && record.type === 'x25519' && record.deletedAt === undefined
        ? await store.version(partition, CONSOLE_COMMAND_KEY, record.latestVersion)
        : null;
    const publicKey = version?.publicKey;
    if (publicKey?.crv !== 'X25519' || !publicKey.kid) {
      throw new Error(
        `crypto: the "${partition}" app has no ${CONSOLE_COMMAND_KEY} key yet (is it up, with consoleCommands.verifyTenant and "${partition}" in its partitions?)`,
      );
    }
    const key: OkpJwk = { kty: 'OKP', crv: 'X25519', x: publicKey.x, kid: publicKey.kid };
    cached = { key, at: Date.now() };
    return key;
  };
}

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
 * says otherwise: read and manage keys, and test or rewrap with them (crypto's console set). Never
 * `crypto:keys:export`.
 */
export const DEFAULT_CONSOLE_CAPABILITIES: readonly string[] = CRYPTO_CONSOLE_CAPABILITIES;

export { CRYPTO_CONSOLE_CAPABILITIES, viewerConsoleCapabilities };

/** Error code of a command (or request) that names no capabilities: the same in every Agora lib. */
export const CAPABILITIES_REQUIRED = 'capabilities-required';

class CommandError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
  }
}

export interface CryptoConsoleCommandHandlerOptions {
  /** This app's crypto service (its store, its root key, its audit). */
  service: CryptoService;
  /** Run key operations at all. */
  actions: boolean;
  /** What the other console may do here. Default {@link DEFAULT_CONSOLE_CAPABILITIES}. */
  capabilities?: readonly string[] | undefined;
  /** The partitions the other console may touch. Empty: none (never "every partition"). */
  partitions: readonly string[];
  /** Keys no console command may touch. Default: the token-mode command key. */
  protectedKeys?: readonly string[] | undefined;
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
  // What this app allows; export is never a console command, whatever is listed.
  const allowed = [...(options.capabilities ?? DEFAULT_CONSOLE_CAPABILITIES)].filter(
    (capability) => !cryptoConsoleAllows([capability], 'crypto:keys:export'),
  );
  const protectedKeys: ReadonlySet<string> = new Set(
    options.protectedKeys ?? [CONSOLE_COMMAND_KEY],
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
    // Never "missing = everything": a command names what its viewer may do, in every mode.
    if (!Array.isArray(command.capabilities)) {
      throw new CommandError(
        "crypto: the console sent no capabilities with this command, so this app runs nothing (update @adonis-agora/crypto on the console: it always sends the viewer's)",
        403,
        CAPABILITIES_REQUIRED,
      );
    }
    // Then the token: the console's token (verified by the channel) says which app it may act on
    // and what it may do; the viewer's capabilities the console sends can only narrow that.
    const body = (command.args[0] ?? {}) as Record<string, unknown>;
    const partition = text(body.partition, 'partition');
    const name = text(body.name, 'name');
    const verified = command.verified;
    // An authkit app-call token is bound to this app by its audience: its partition is the caller.
    if (verified && !verified.appCall && verified.partition !== partition) {
      throw new CommandError(
        `crypto: the console's token is for "${verified.partition}", not "${partition}"`,
        403,
      );
    }
    const viewer = command.capabilities as string[];
    const tokenCaps = verified ? verified.capabilities : undefined;
    // The verb's capability, on the token then on the viewer, before this app's own rules.
    const needs = commandRequirement(verb, name);
    const lacking =
      tokenCaps && !needs.some((c) => cryptoConsoleAllows(tokenCaps, c))
        ? "the console's token lacks"
        : !needs.some((c) => cryptoConsoleAllows(viewer, c))
          ? 'the viewer lacks'
          : undefined;
    if (lacking) {
      // Recorded in this app's audit like any refusal, when the key is one it serves.
      if (options.partitions.includes(partition) && !protectedKeys.has(name)) {
        await run(
          options.service,
          verb as CryptoConsoleVerb,
          {
            partition,
            capabilities: [],
            actor: actorOf(command),
            clientId: `console:${viaOf(command)}`,
          },
          name,
          (command.args[0] ?? {}) as Record<string, unknown>,
          viaOf(command),
        ).catch(() => undefined);
      }
      throw new CommandError(`crypto: ${lacking} ${needs[0]}`, 403, 'forbidden');
    }
    // Then this app's own rules: actions, served partitions, protected keys.
    if (!options.actions) {
      throw new CommandError(
        'this app does not run key operations from another console (consoleCommands.actions is off)',
        403,
      );
    }
    if (!options.partitions.includes(partition)) {
      throw new CommandError(
        `crypto: this app does not serve "${partition}" to other consoles`,
        403,
      );
    }
    if (protectedKeys.has(name)) {
      throw new CommandError(
        `crypto: "${name}" authenticates the console itself and is managed by this app only`,
        403,
      );
    }
    const actor = actorOf(command);
    const via = viaOf(command);
    // The principal holds exactly the operations this command may use that this app, the token
    // and the viewer all allow: concrete capabilities, so the service's own matcher cannot widen.
    const capabilities = commandCandidates(verb, name).filter(
      (c) =>
        cryptoConsoleAllows(allowed, c) &&
        (tokenCaps === undefined || cryptoConsoleAllows(tokenCaps, c)) &&
        cryptoConsoleAllows(viewer, c),
    );
    const principal: CryptoPrincipal = {
      partition,
      capabilities,
      actor,
      clientId: `console:${via}`,
    };
    options.log?.(
      `[crypto] federated console: ${verb} ${partition}/${name} by ${actor} via ${via}${verified?.clientId ? ` (token ${verified.clientId})` : ''}`,
    );
    try {
      return await run(options.service, verb as CryptoConsoleVerb, principal, name, body, via);
    } catch (error) {
      const missing =
        error instanceof CryptoError && error.code === 'forbidden'
          ? /the token lacks (\S+)/.exec(error.message)?.[1]
          : undefined;
      if (!missing) throw error;
      const who = !cryptoConsoleAllows(allowed, missing)
        ? "this app's consoleCommands.capabilities do not allow"
        : tokenCaps && !cryptoConsoleAllows(tokenCaps, missing)
          ? "the console's token lacks"
          : 'the viewer lacks';
      throw new CryptoError('forbidden', `crypto: ${who} ${missing}`);
    }
  };
}

const actorOf = (command: ConsoleCommand): string =>
  typeof command.actor === 'string' && command.actor !== '' ? command.actor : 'console';
const viaOf = (command: ConsoleCommand): string =>
  typeof command.via === 'string' && command.via !== '' ? command.via : 'federated';

async function run(
  service: CryptoService,
  verb: CryptoConsoleVerb,
  principal: CryptoPrincipal,
  name: string,
  body: Record<string, unknown>,
  via: string,
): Promise<unknown> {
  switch (verb) {
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
}

/* ------------------------------------------------------------------------------------------- */
/* The console: another app as it sees it                                                       */
/* ------------------------------------------------------------------------------------------- */

/** What the console sends with a command, besides its arguments. */
export interface CommandMeta {
  actor: string;
  /**
   * What the console's `authorize` granted the viewer, narrowed to the crypto console set. Omitted:
   * the whole set is sent (the app caps it with its own `capabilities`, and a token's); an app
   * refuses a command that names none.
   */
  capabilities?: string[] | undefined;
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
          capabilities: meta.capabilities ?? viewerConsoleCapabilities(undefined),
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
    /** This console's own crypto service: automatic crypto mode seals with its keys. */
    service?: CryptoService | undefined;
    /** `@adonis-agora/authkit-client`, when booted here: its app-call tokens go with commands. */
    authkit?: AuthkitClientLike | undefined;
    /** Told when an automatic authkit token could not be minted (the command went crypto-only). */
    onTokenUnavailable?: ((id: string, partition: string, reason: string) => void) | undefined;
    /** Told when automatic crypto mode created the `console-crypto` key in a partition. */
    onKeyCreated?: ((partition: string, key: string) => void) | undefined;
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
  const plane = config.controlPlane;
  let channel: RedisConsoleChannel;
  if (plane instanceof RedisConsoleChannel) {
    channel = plane;
  } else {
    const mode = resolveConsoleSideMode(id, config, {
      authkit: deps.authkit,
      hasService: deps.service !== undefined,
    });
    const crypto: ConsoleCryptoOptions | undefined =
      mode.kind === 'crypto'
        ? mode.crypto
        : mode.kind === 'crypto-auto' && deps.service
          ? {
              cipher: autoConsoleCipher(deps.service, mode.partition, {
                ...(deps.onKeyCreated ? { onCreated: deps.onKeyCreated } : {}),
              }),
            }
          : undefined;
    channel = new RedisConsoleChannel({
      client: await deps.redis(plane.connection),
      prefix: plane.prefix,
      app: config.label ?? id,
      ...(mode.secret !== undefined ? { secret: mode.secret } : {}),
      ...(crypto !== undefined ? { crypto } : {}),
      ...(mode.token !== undefined ? { token: mode.token } : {}),
      // An automatic authkit token: optional with crypto (never blocks a command), required
      // without, with what to grant when it cannot be minted.
      ...(mode.autoToken
        ? {
            tokenOptional: true,
            tokenHint: appCallGrantHint(mode.partition),
            onTokenUnavailable: (reason: string) =>
              deps.onTokenUnavailable?.(id, mode.partition, reason),
          }
        : {}),
      // The app's command key, read from its store: only needed without crypto.
      ...(mode.token !== undefined && crypto === undefined
        ? { recipient: commandKeyReader(store, mode.partition) }
        : {}),
    });
  }
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
