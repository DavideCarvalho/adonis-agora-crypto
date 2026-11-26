import { CryptoError, type TenantTokenSource } from '@adonis-agora/crypto-core';
import type { CryptoPrincipal, CryptoService } from '../crypto/service.js';
import type { CryptoConfig } from '../define_config.js';
import type { TenantVerifierInput } from '../topology/verify.js';
import type { FederatedCryptoAppConfig } from './console.js';
import {
  type AppCallVerifier,
  type ChannelSecret,
  CONSOLE_CRYPTO_KEY,
  type CommandTokenRule,
  type ConsoleCipher,
  type ConsoleCryptoOptions,
  RedisConsoleChannel,
} from './redis_channel.js';

/**
 * How each side of a federated crypto console authenticates, resolved once from the config and
 * the sibling libs booted in the same app, so the provider (boot), the doctor and the docs say the
 * same thing.
 *
 * Automatic crypto mode is one-sided in this package. The console (the Hub) always embeds a crypto
 * server, so it seals with its own `console-crypto` key in the federated app's partition and
 * creates that key when it is missing: no line on the Hub. The owning app, though, runs its OWN
 * crypto server (own store, own root key): the Hub's key lives on another server, reachable only
 * through a client the app configures (`consoleCommands.crypto.cipher`). So the app side never
 * resolves crypto mode by itself; it resolves a token verifier (authkit's app-call verifier, a
 * control plane's own `verifyTenant`) when one is there, and fails at boot when nothing resolves.
 *
 * `@adonis-agora/authkit-client` (`'authkit.client'`) is detected structurally, never imported: its
 * app-call tokens authenticate the console, its app-caller verifier checks them on the app.
 */

const PACKAGE = '@adonis-agora/crypto';

/** Thrown at boot when one side cannot authenticate console commands. */
export class ConsoleAuthConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConsoleAuthConfigError';
  }
}

const DOCTOR_HINT = "Run `node ace agora:doctor` to see every Agora lib's console auth at once.";

/** ` Note: …` after the template, when an automatic mode was switched off. */
const notesOf = (notes: string[]) => (notes.length ? ` Note: ${notes.join('; ')}.` : '');

/** Where every boot error points. */
export const CONSOLE_AUTH_DOCS =
  'https://davidecarvalho.github.io/agora/docs/crypto/federated-console#authenticating-the-console';

/* ------------------------------------------------------------------------------------------- */
/* authkit-client, detected                                                                     */
/* ------------------------------------------------------------------------------------------- */

/** The `'authkit.client'` binding of `@adonis-agora/authkit-client`, as far as crypto uses it. */
export interface AuthkitClientLike {
  /** Tokens for calls to other apps (its `apps` config), or `undefined` without one. */
  appCallTokens?(): { token(app: string): Promise<string>; reset?(): void } | undefined;
  /** Verifies app-call tokens addressed to this app (its `service` config), or `null`. */
  appCallerVerifier?(): {
    verifyToken(token: string): Promise<{
      app: string;
      capabilities: string[];
      clientId: string;
      expiresAt?: number;
    } | null>;
  } | null;
}

interface ContainerLike {
  hasBinding(binding: string): boolean;
  make(binding: string): Promise<unknown>;
}

/** `@adonis-agora/authkit-client` when it is booted in this app, else `undefined`. */
export async function authkitClientOf(container: unknown): Promise<AuthkitClientLike | undefined> {
  const c = container as ContainerLike;
  if (typeof c?.hasBinding !== 'function' || !c.hasBinding('authkit.client')) return undefined;
  try {
    const client = await c.make('authkit.client');
    return client && typeof client === 'object' ? (client as AuthkitClientLike) : undefined;
  } catch (error) {
    throw new Error(
      `[${PACKAGE}] @adonis-agora/authkit-client is installed but did not boot, so console commands cannot use it: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** The app-call verifier authkit-client already configured (its `service`), if any. */
export function appCallVerifierOf(
  authkit: AuthkitClientLike | undefined,
): AppCallVerifier | undefined {
  const verifier = authkit?.appCallerVerifier?.();
  if (!verifier || typeof verifier.verifyToken !== 'function') return undefined;
  return (token) => verifier.verifyToken(token);
}

/** The app-call token for `target` authkit-client already configured (its `apps`), if any. */
export function appCallTokenOf(
  authkit: AuthkitClientLike | undefined,
  target: string,
): TenantTokenSource | undefined {
  const tokens = authkit?.appCallTokens?.();
  if (!tokens || typeof tokens.token !== 'function') return undefined;
  return Object.assign(() => tokens.token(target), { reset: () => tokens.reset?.() });
}

/* ------------------------------------------------------------------------------------------- */
/* The owning app (answers commands)                                                             */
/* ------------------------------------------------------------------------------------------- */

export interface AppCommandModes {
  crypto?: ConsoleCryptoOptions | undefined;
  /** Whether crypto commands must carry a token. */
  cryptoToken?: CommandTokenRule | undefined;
  /** A tenant-token verifier: `consoleCommands.verifyTenant`, else a control plane's own. */
  verifyTenant?: TenantVerifierInput | undefined;
  /** An authkit app-call verifier (automatic). */
  verifyAppCall?: AppCallVerifier | undefined;
  secret?: ChannelSecret | undefined;
  /** Token mode sealed to this app's own X25519 `console-commands` key. */
  sealedToApp: boolean;
  /** One line per accepted mode, for the boot log and the doctor. Empty: unauthenticated. */
  modes: string[];
}

/**
 * What `consoleCommands` accepts: every mode it can resolve at once (cheap: no store, no network).
 * `undefined` when there is no `consoleCommands`.
 */
export function resolveAppCommandModes(
  config: CryptoConfig,
  siblings: { authkit?: AuthkitClientLike | undefined } = {},
): AppCommandModes | undefined {
  if (config.topology === 'tenant') return undefined;
  const options = config.consoleCommands;
  if (!options) return undefined;
  const crypto = options.crypto ? options.crypto : undefined;
  const explicitVerify = options.verifyTenant ? options.verifyTenant : undefined;
  const resolved: AppCommandModes = { sealedToApp: false, modes: [] };

  // Tokens: an explicit verifier only; else authkit's app-call verifier and a control plane's own.
  const sources: string[] = [];
  if (explicitVerify !== undefined) {
    resolved.verifyTenant = explicitVerify;
    sources.push('verifyTenant');
  } else if (options.verifyTenant !== false) {
    resolved.verifyAppCall = appCallVerifierOf(siblings.authkit);
    if (resolved.verifyAppCall) sources.push('authkit app-call, auto');
    if (config.topology === 'control-plane' && config.verifyTenant !== undefined) {
      resolved.verifyTenant = config.verifyTenant;
      sources.push("the control plane's verifyTenant");
    }
  }
  const hasVerifier = sources.length > 0;

  if (crypto) {
    resolved.crypto = crypto;
    // Explicit crypto + explicit verifyTenant: every command must carry a token.
    resolved.cryptoToken =
      explicitVerify !== undefined ? 'required' : hasVerifier ? 'optional' : 'none';
    resolved.modes.push(`crypto (key ${crypto.key ?? CONSOLE_CRYPTO_KEY})`);
    if (resolved.cryptoToken === 'required') {
      resolved.modes.push(`token required (${sources.join(', ')})`);
    } else if (resolved.cryptoToken === 'optional') {
      resolved.modes.push(`token checked when sent (${sources.join(', ')})`);
    }
  }
  if (hasVerifier) {
    resolved.sealedToApp = true;
    // `{sealedTo}` is replaced by the command key's short id once it exists (ready()).
    resolved.modes.push(`token (${sources.join(', ')}; sealed to {sealedTo})`);
  }
  if (options.secret !== undefined) {
    resolved.secret = options.secret;
    resolved.modes.push('secret');
  }
  return resolved;
}

/**
 * The boot error (and doctor fix) when `consoleCommands` resolves no mode. The uniform template,
 * with crypto's own first option: this app runs its own crypto server, so it opens the console's
 * `console-crypto` commands through a client of the console's crypto server.
 */
export function appUnauthenticatedMessage(config: CryptoConfig): string {
  const options = config.topology === 'tenant' ? undefined : config.consoleCommands;
  const notes = [
    ...(options?.crypto === false ? ['`crypto: false` turned crypto mode off'] : []),
    ...(options?.verifyTenant === false
      ? [
          "`verifyTenant: false` turned the automatic verifiers off (authkit-client's app-caller verifier, a control plane's own)",
        ]
      : []),
  ];
  return `[${PACKAGE}] consoleCommands needs authentication: set consoleCommands.crypto (a client of the console's crypto server for this app's partition; the console seals with key ${CONSOLE_CRYPTO_KEY} automatically), or configure authkit-client's \`service\` (automatic: the console uses an authkit app-call token; grant it crypto:console:* on this app), or set consoleCommands.secret (shared with the console), or consoleCommands.verifyTenant (your own verifier). ${DOCTOR_HINT} Docs: ${CONSOLE_AUTH_DOCS}${notesOf(notes)}`;
}

/* ------------------------------------------------------------------------------------------- */
/* The console (sends commands)                                                                  */
/* ------------------------------------------------------------------------------------------- */

export interface ConsoleSideMode {
  kind:
    | 'browse-only'
    | 'channel'
    | 'crypto'
    | 'crypto-auto'
    | 'token'
    | 'secret'
    | 'unauthenticated';
  /** For the boot log and the doctor. */
  describe: string;
  /** The federated app's partition (on this server, in automatic crypto mode). */
  partition: string;
  /** Crypto mode: the key commands are sealed with. */
  key?: string | undefined;
  /** Explicit crypto options (`kind: 'crypto'`). */
  crypto?: ConsoleCryptoOptions | undefined;
  /** The token each command carries (explicit, or authkit's app-call token). */
  token?: TenantTokenSource | undefined;
  /** Whether {@link token} is authkit's app-call token, resolved automatically. */
  autoToken?: boolean | undefined;
  secret?: ChannelSecret | undefined;
}

/** How this console sends commands to the federated app `id` (what its channel will use). */
export function resolveConsoleSideMode(
  id: string,
  entry: FederatedCryptoAppConfig,
  siblings: { authkit?: AuthkitClientLike | undefined; hasService?: boolean } = {},
): ConsoleSideMode {
  const partition = entry.partition ?? id;
  const plane = entry.controlPlane;
  if (plane instanceof RedisConsoleChannel) {
    return { kind: 'channel', describe: 'its own RedisConsoleChannel', partition };
  }
  if (entry.actions === false) {
    return { kind: 'browse-only', describe: 'none (actions: false, browse only)', partition };
  }
  const explicitCrypto = plane?.crypto ? plane.crypto : undefined;
  const explicitToken = plane?.token ? plane.token : undefined;
  const secret = plane?.secret;
  const explicit =
    secret !== undefined || explicitToken !== undefined || explicitCrypto !== undefined;

  let token: TenantTokenSource | undefined;
  let tokenLabel: string | undefined;
  let autoToken = false;
  if (explicitToken !== undefined) {
    token = explicitToken;
    tokenLabel = 'token';
  } else if (plane?.token !== false && secret === undefined) {
    token = appCallTokenOf(siblings.authkit, partition);
    if (token) tokenLabel = 'token (authkit app-call, auto)';
    autoToken = token !== undefined;
  }
  const withToken = tokenLabel ? ` + ${tokenLabel}` : '';

  if (explicitCrypto) {
    const key = explicitCrypto.key ?? CONSOLE_CRYPTO_KEY;
    return {
      kind: 'crypto',
      key,
      crypto: explicitCrypto,
      partition,
      describe: `crypto (key ${key})${withToken}`,
      ...(token ? { token, autoToken } : {}),
      ...(secret !== undefined ? { secret } : {}),
    };
  }
  if (!explicit && plane?.crypto !== false && siblings.hasService !== false) {
    return {
      kind: 'crypto-auto',
      key: CONSOLE_CRYPTO_KEY,
      partition,
      describe: `crypto (auto, key ${CONSOLE_CRYPTO_KEY}, partition ${partition})${withToken}`,
      ...(token ? { token, autoToken } : {}),
    };
  }
  if (token) {
    return {
      kind: 'token',
      partition,
      token,
      autoToken,
      describe:
        explicitToken !== undefined
          ? "token (sealed to the app's console-commands key)"
          : "token (authkit app-call, auto; sealed to the app's console-commands key)",
      ...(secret !== undefined ? { secret } : {}),
    };
  }
  if (secret !== undefined) return { kind: 'secret', partition, secret, describe: 'secret' };
  return {
    kind: 'unauthenticated',
    partition,
    describe: `unauthenticated${plane?.crypto === false ? ' (crypto: false)' : ''}`,
  };
}

/** What to grant so the console's authkit app-call token for `app` can be minted. */
export function appCallGrantHint(app: string): string {
  return `To attach it: grant the console's service client crypto:console:* on "${app}" in authkit.`;
}

/**
 * The line a console logs when an automatic authkit token cannot be minted in crypto mode (the
 * command went crypto-only): `info` when the console's client is simply not granted that app
 * (`invalid_target`, "not granted", "no grant"), `warn` for anything else (authkit unreachable, a bad secret).
 */
export function tokenUnavailableLog(
  id: string,
  partition: string,
  reason: string,
): { level: 'info' | 'warn'; line: string } {
  const missingGrant = /invalid_target|not granted|no grant/i.test(reason);
  return {
    level: missingGrant ? 'info' : 'warn',
    line: `[${PACKAGE}] console commands to "${id}": sending without an authkit app-call token (crypto only): ${reason}. ${appCallGrantHint(partition)}`,
  };
}

/** The boot error (and doctor fix) for a federated app this console cannot authenticate to. */
export function consoleUnauthenticatedMessage(
  id: string,
  entry?: FederatedCryptoAppConfig,
): string {
  const plane =
    entry && !(entry.controlPlane instanceof RedisConsoleChannel) ? entry.controlPlane : undefined;
  const notes = [
    ...(plane?.crypto === false ? ['`crypto: false` turned the automatic crypto mode off'] : []),
    ...(plane?.token === false ? ['`token: false` turned the automatic authkit token off'] : []),
  ];
  const path = `console.federatedApps["${id}"]`;
  return `[${PACKAGE}] ${path}: commands to this app need authentication: boot @adonis-agora/crypto in this app (automatic), or set ${path}.controlPlane.secret, or ${path}.controlPlane.token — or actions: false to only browse it. ${DOCTOR_HINT}${notesOf(notes)}`;
}

/* ------------------------------------------------------------------------------------------- */
/* The console's own crypto key (automatic crypto mode)                                         */
/* ------------------------------------------------------------------------------------------- */

/**
 * Makes sure `partition` of this crypto server holds the `aes256-gcm` key console commands are
 * sealed with. Idempotent (another instance creating it first is fine); a key of that name that is
 * not a live `aes256-gcm` one is reported, never replaced.
 */
export async function ensureConsoleCryptoKey(
  service: CryptoService,
  partition: string,
  key: string = CONSOLE_CRYPTO_KEY,
): Promise<'created' | 'present'> {
  const existing = await service.store.getKey(partition, key);
  if (existing) {
    if (existing.type !== 'aes256-gcm' || existing.deletedAt !== undefined) {
      throw new Error(
        `"${partition}/${key}" exists but is not a live aes256-gcm key, so console commands cannot be sealed with it; delete or rename it, or set controlPlane.crypto explicitly`,
      );
    }
    return 'present';
  }
  try {
    await service.createKey(
      { partition, capabilities: [`crypto:keys:manage:${key}`], actor: 'crypto:console' },
      {
        name: key,
        type: 'aes256-gcm',
        description: 'Seals federated console commands (automatic crypto mode)',
      },
    );
    return 'created';
  } catch (error) {
    if (error instanceof CryptoError && error.code === 'conflict') return 'present';
    throw error;
  }
}

/**
 * Console side, automatic crypto mode: an encrypt-only cipher over this server's own service, with
 * the narrowest principal (`crypto:encrypt:console-crypto` in the federated app's partition). The
 * key is created there on first use when the boot did not (never at boot outside the web process).
 */
export function autoConsoleCipher(
  service: CryptoService,
  partition: string,
  options: { key?: string; onCreated?: (partition: string, key: string) => void } = {},
): ConsoleCipher {
  const key = options.key ?? CONSOLE_CRYPTO_KEY;
  const principal: CryptoPrincipal = {
    partition,
    capabilities: [`crypto:encrypt:${key}`],
    actor: 'crypto:console',
  };
  let ensured: Promise<unknown> | undefined;
  const ensure = () => {
    ensured ??= ensureConsoleCryptoKey(service, partition, key).then(
      (made) => {
        if (made === 'created') options.onCreated?.(partition, key);
      },
      (error: unknown) => {
        ensured = undefined;
        throw error;
      },
    );
    return ensured;
  };
  return {
    async encrypt(input) {
      await ensure();
      return service.encrypt(principal, input);
    },
    async decrypt() {
      throw new Error(`[${PACKAGE}] the console side never opens console commands`);
    },
  };
}
