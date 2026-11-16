import type { CryptoDashboardConfig } from './dashboard/define_config.js';
import type { SqlDatabase } from './sql.js';
import type { CryptoStore } from './store/store.js';

export type { CryptoKeyringConfig } from './crypto/keyring.js';

import type {
  CryptoTransport,
  ServerUrlSource,
  TenantTokenSource,
} from '@adonis-agora/crypto-core';
import type { CryptoKeyringConfig } from './crypto/keyring.js';
import { LucidStore } from './store/lucid_store.js';
import { MemoryStore } from './store/memory_store.js';
import type { DataKeyCacheOptions } from './subjects/cache.js';
import { type DataKeyStore, LucidDataKeyStore, MemoryDataKeyStore } from './subjects/store.js';
import type { SubjectId } from './subjects/subject_keys.js';
import type { TenantVerifierInput } from './topology/verify.js';
import type { BrokerDriver } from './transports/broker.js';

/** What store factories receive. */
export interface FactoryContext {
  /** A Lucid query client (the default connection when omitted), optionally bound to a schema. */
  db(connection?: string, schema?: string): Promise<SqlDatabase>;
  /**
   * The same, resolved again on every call (so a Lucid global transaction is used when one is
   * open). Absent in custom contexts: fall back to `db`.
   */
  dbResolver?(connection?: string, schema?: string): Promise<() => SqlDatabase>;
  autoCreateSchema: boolean;
}

export type Factory<T> = (context: FactoryContext) => T | Promise<T>;

export const stores = {
  /** Keys and the audit trail in your database (Postgres, MySQL, SQLite). The default. */
  lucid(options: { connection?: string; autoCreateSchema?: boolean } = {}): Factory<CryptoStore> {
    return async (context) =>
      new LucidStore(await context.db(options.connection), {
        autoCreateSchema: options.autoCreateSchema ?? context.autoCreateSchema,
      });
  },
  /** In process memory: tests and local development (key material is still sealed). */
  memory(): Factory<CryptoStore> {
    return () => new MemoryStore();
  },
};

/** Where an app keeps the wrapped data keys of its subjects (`crypto_data_keys`). */
export const dataKeyStores = {
  /** In the app's database, through Lucid (Postgres, MySQL, SQLite). The default. */
  lucid(
    options: { connection?: string; autoCreateSchema?: boolean; schema?: string } = {},
  ): Factory<DataKeyStore> {
    return async (context) =>
      new LucidDataKeyStore(
        context.dbResolver
          ? await context.dbResolver(options.connection, options.schema)
          : await context.db(options.connection, options.schema),
        {
          autoCreateSchema: options.autoCreateSchema ?? context.autoCreateSchema,
        },
      );
  },
  /** In process memory: tests and local development. */
  memory(): Factory<DataKeyStore> {
    return () => new MemoryDataKeyStore();
  },
};

/**
 * Per-subject keys with local envelopes (`crypto.subjects`): one key per subject on the crypto
 * server, values sealed in this process with cached data keys. Works in every topology.
 */
export interface CryptoSubjectsConfig {
  /** Key name of a subject: `${prefix}${id}`. Default `subject_`. */
  prefix?: string;
  /** Full control over the key name. Overrides `prefix`. */
  keyName?: (id: SubjectId, type: string | undefined) => string;
  /** Refuse bare ids: every subject is `{ type, id }` (or a column `namespace`). Default `false`. */
  requireType?: boolean;
  /** `lazy` (default): a subject's key is created on its first write. `explicit`: `subjects.create(id)` first. */
  createKeys?: 'lazy' | 'explicit';
  /**
   * Unwrapped data keys kept in memory: `{ maxEntries: 1000, ttlMs: 300_000 }` by default. `false`
   * asks the crypto server on every read and write.
   */
  cache?: DataKeyCacheOptions | false;
  /** Where the wrapped data keys live. Default `dataKeyStores.lucid()` (the app's database). */
  store?: Factory<DataKeyStore>;
}

/** One outbound target: the origin itself, or the origin plus its own key. */
export type CryptoEnvelopeTarget = string | { url: string; key?: string };

/**
 * App-to-app encryption, wired by configuration only: every app keeps calling plain `fetch` and
 * serving plain routes, and the provider installs the two halves.
 *
 * - **outbound**: an undici interceptor composed onto the global dispatcher seals the JSON body of a
 *   request to a configured exact origin (composed, never replacing the dispatcher, so telescope's
 *   trace interceptor and authkit-client's token interceptor keep working);
 * - **inbound**: a server middleware opens the envelope before the route reads the body, so
 *   `request.body()`, `request.all()` and `request.validateUsing()` see the plaintext.
 *
 * The key is an `aes256-gcm` key both sides hold on the crypto server under the same name.
 */
export interface CryptoEnvelopeConfig {
  /** Outbound: name → origin. Bodies sent to these **exact origins** are sealed; nothing else is. */
  targets?: Record<string, CryptoEnvelopeTarget>;
  /** The shared key every target uses. A target may override it with `{ url, key }`. */
  key?: string;
  /** Inbound: the key names this app opens (`x-crypto-key`). Default: `key`. */
  accept?: string | string[];
  /**
   * The crypto app (partition) whose keys hold the shared key. Default: the app's own partition —
   * required on a control plane, where there is no single app.
   */
  partition?: string;
  /** Extra AAD bound into every envelope. Both sides must configure the same value. */
  aad?: string;
  /** Refuse a request when it carries no envelope. Default `false` (it passes through untouched). */
  required?: boolean;
  /** Refuse an envelope older than this, in seconds. Default `300`. */
  maxAgeSec?: number;
  /** How far in the future an `iat` may be, in seconds. Default `60`. */
  clockSkewSec?: number;
  /** Largest envelope accepted on the way in, in bytes. Default 2 MiB. */
  maxBytes?: number;
  /** Set `false` to install only the outbound interceptor. Default: on when a key is accepted. */
  inbound?: boolean;
  /** Set `false` to install only the inbound middleware. Default: on when `targets` is set. */
  outbound?: boolean;
}

interface BaseConfig {
  /** Warehouse this process belongs to. Default `production` on a server, `NODE_ENV` on a tenant. */
  environment?: string;
  /** How this server seals its own key material. Default: the app's encryption service. */
  crypto?: CryptoKeyringConfig;
  /** Batch ceiling for the batch endpoints. Default `100`. */
  maxBatchSize?: number;
  /** App-to-app encryption (interceptor + middleware). Nothing is installed when this is absent. */
  envelope?: CryptoEnvelopeConfig;
  /** Per-subject keys and encrypted columns. Nothing is set up when this is absent. */
  subjects?: CryptoSubjectsConfig;
}

/** An app that owns its keys locally and calls itself in process (no HTTP hop). */
export interface StandaloneConfig extends BaseConfig {
  topology?: 'standalone';
  /** This app's name (the partition). */
  app: string;
  /** Where keys and the audit trail live. Default `stores.lucid()`. */
  store?: Factory<CryptoStore>;
  /** Create the tables at boot. Default `true`. */
  autoCreateSchema?: boolean;
  /** Postgres: keep every table in this schema (created separately). */
  schema?: string;
  /** Mount the console (the SPA + its JSON API). Default on. */
  console?: CryptoDashboardConfig | false;
}

/** The server every app connects to. */
export interface ControlPlaneConfig extends BaseConfig {
  topology: 'control-plane';
  /**
   * Validates a tenant's token. TOP LEVEL, in the same place in every Agora lib, and it accepts the
   * three forms: a function, a class instance, or `() => import('./verifier.js')`. The app and the
   * capabilities come from the verified token — never from the request.
   *
   * With authkit: `authkitTenantVerifier({ issuer, resource: 'urn:agora:crypto' })` from
   * `@adonis-agora/authkit-client`. Without it: `sharedSecretVerifier({ partitions: { … } })`.
   */
  verifyTenant: TenantVerifierInput;
  /** Route prefix for the tenant API. Default `/_crypto`. */
  prefix?: string;
  /** Origins allowed to call the tenant API cross-origin. Default: none. */
  corsOrigins?: string[];
  /**
   * Consume the call channel from a broker instead of (or besides) HTTP: the same driver the
   * tenant uses, served here with `verifyTenant` on every message. Default: HTTP only.
   */
  transport?: BrokerDriver;
  store?: Factory<CryptoStore>;
  autoCreateSchema?: boolean;
  /** Postgres: keep every table in this schema (created separately). */
  schema?: string;
  /** Mount the console (the SPA + its JSON API). Default on. */
  console?: CryptoDashboardConfig | false;
}

/** An app that asks a central crypto server for every operation. */
export interface TenantTopologyConfig extends BaseConfig {
  topology: 'tenant';
  tenant: {
    /**
     * The server's base URL, including its prefix (`https://crypto.example.com/_crypto`), or a
     * function that resolves it before the first call — `controlPlaneUrl({ issuer, resource:
     * 'urn:agora:crypto' })` from `@adonis-agora/authkit-client`. A function is looked up again
     * (its `refresh()` when it has one) after a connection error or a 404.
     */
    url: ServerUrlSource;
    /** This app's name on the server (the partition). */
    partition: string;
    /**
     * The bearer token: a fixed shared secret, a function, or an object with `get()`. With authkit:
     * `authkitTenantToken({ issuer, clientId, clientSecret, resource: 'urn:agora:crypto' })`.
     */
    token: TenantTokenSource;
    /** Per request. Default `10000`. */
    timeoutMs?: number;
    /** Retries after a network error, a 429 or a 5xx. Default `2`. */
    retries?: number;
    /** Check the token against the server at boot (a warning when it fails). Default `true`. */
    checkOnBoot?: boolean;
    /**
     * How this app reaches the control plane. Default `transports.http({ url })`. Any driver from
     * `transports` works — a broker (`transports.redis(...)`, `transports.durable(...)`) is adapted
     * with the shared envelope, with a documented latency.
     */
    transport?: CryptoTransport | BrokerDriver;
  };
  /** FORBIDDEN on a tenant: it holds no keys; the server does. */
  store?: never;
  crypto?: never;
  autoCreateSchema?: never;
  schema?: never;
  console?: never;
  maxBatchSize?: never;
}

export type CryptoConfig = StandaloneConfig | ControlPlaneConfig | TenantTopologyConfig;

/** Identity helper that types `config/config.ts`, and refuses shapes that cannot work. */
export function defineConfig(config: CryptoConfig): CryptoConfig {
  const raw = config as CryptoConfig & { verifyTenant?: unknown };
  if (config.topology === 'tenant') {
    if (!config.tenant.url) throw new Error('crypto: tenant.url is required');
    if (!config.tenant.partition) throw new Error('crypto: tenant.partition is required');
    if (!config.tenant.token) {
      throw new Error(
        "crypto: tenant.token is required (authkitTenantToken({ issuer, clientId, clientSecret, resource: 'urn:agora:crypto' }) or the shared secret)",
      );
    }
    if (typeof config.tenant.url !== 'function' && !/^https?:\/\//.test(config.tenant.url)) {
      throw new Error('crypto: tenant.url must be an absolute http(s) URL or a function');
    }
    if (raw.verifyTenant !== undefined) {
      throw new Error('crypto: `verifyTenant` only applies to topology "control-plane"');
    }
  }
  if (config.topology === 'control-plane') {
    if (!raw.verifyTenant) {
      throw new Error(
        "crypto: a control plane needs `verifyTenant` (authkitTenantVerifier({ issuer, resource: 'urn:agora:crypto' }) or sharedSecretVerifier({ partitions })) — a tenant must never be trusted without a token",
      );
    }
    const kind = typeof raw.verifyTenant;
    if (
      kind !== 'function' &&
      !(
        kind === 'object' && typeof (raw.verifyTenant as { verify?: unknown }).verify === 'function'
      )
    ) {
      throw new Error(
        'crypto: `verifyTenant` must be a function, an object with verify() (a class instance), or a lazy import of one',
      );
    }
  }
  if (config.topology !== 'control-plane' && raw.verifyTenant !== undefined) {
    throw new Error('crypto: `verifyTenant` only applies to topology "control-plane"');
  }
  if ((config.topology ?? 'standalone') === 'standalone' && !('app' in config && config.app)) {
    throw new Error('crypto: `app` is required on a standalone app');
  }
  return config;
}
