import type { CryptoDashboardConfig } from './dashboard/define_config.js';
import type { SqlDatabase } from './sql.js';
import type { CryptoStore } from './store/store.js';

export type { CryptoKeyringConfig } from './crypto/keyring.js';

import type { CryptoTransport, TenantTokenSource } from '@adonis-agora/crypto-core';
import type { CryptoKeyringConfig } from './crypto/keyring.js';
import { LucidStore } from './store/lucid_store.js';
import { MemoryStore } from './store/memory_store.js';
import type { TenantVerifierInput } from './topology/verify.js';
import type { BrokerDriver } from './transports/broker.js';

/** What store factories receive. */
export interface FactoryContext {
  /** A Lucid query client (the default connection when omitted). */
  db(connection?: string): Promise<SqlDatabase>;
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

interface BaseConfig {
  /** Warehouse this process belongs to. Default `production` on a server, `NODE_ENV` on a tenant. */
  environment?: string;
  /** How this server seals its own key material. Default: the app's encryption service. */
  crypto?: CryptoKeyringConfig;
  /** Batch ceiling for the batch endpoints. Default `100`. */
  maxBatchSize?: number;
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
    /** The server's base URL, including its prefix (`https://crypto.example.com/_crypto`). */
    url: string;
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
    if (!/^https?:\/\//.test(config.tenant.url)) {
      throw new Error('crypto: tenant.url must be an absolute http(s) URL');
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
