import { createCryptoClient } from '@adonis-agora/crypto-client';
import type { ApplicationService } from '@adonisjs/core/types';
import { createCryptoKeyring, type EncrypterLike, type Keyring } from '../src/crypto/keyring.js';
import { CryptoService } from '../src/crypto/service.js';
import {
  type ControlPlaneConfig,
  type CryptoConfig,
  type CryptoKeyringConfig,
  type FactoryContext,
  type StandaloneConfig,
  stores,
  type TenantTopologyConfig,
} from '../src/define_config.js';
import { CryptoApi } from '../src/http/api.js';
import { localOperations, remoteOperations } from '../src/operations.js';
import type { CryptoRuntime } from '../src/runtime.js';
import { setRuntime } from '../src/services/accessor.js';
import { inSchema, type SqlDatabase } from '../src/sql.js';
import type { CryptoStore } from '../src/store/store.js';
import { resolveTenantVerifier } from '../src/topology/verify.js';

declare module '@adonisjs/core/types' {
  interface ContainerBindings {
    'agora.crypto': CryptoRuntime;
  }
}

/** This console's id in the `'agora.consoles'` registry. */
export const CONSOLE_ID = 'crypto';

/**
 * Builds the crypto runtime from `config/crypto.ts` and publishes it as `'agora.crypto'` and as
 * `services/main`.
 *
 * - **control plane**: mounts the tenant API under `/_crypto/v1` (the console and the dev tools
 *   come with it).
 * - **tenant**: every operation goes to the server over HTTP; no key material in this process.
 * - **standalone**: the same API in process, so an app starts local and moves to a central server
 *   by changing `config/crypto.ts` only.
 */
export default class CryptoProvider {
  #runtime: CryptoRuntime | undefined;
  #building: Promise<CryptoRuntime> | undefined;

  constructor(protected app: ApplicationService) {}

  register(): void {
    this.app.container.singleton('agora.crypto', () => this.#build());
  }

  #config(): CryptoConfig {
    const config = this.app.config.get<CryptoConfig | undefined>('crypto');
    if (!config) {
      throw new Error('crypto/config.ts is missing (node ace configure @adonis-agora/crypto)');
    }
    return config;
  }

  #build(): Promise<CryptoRuntime> {
    this.#building ??= this.#doBuild();
    return this.#building;
  }

  async #doBuild(): Promise<CryptoRuntime> {
    const config = this.#config();
    const logger = await this.#logger();
    if (config.topology === 'tenant') return this.#tenant(config, logger);
    return this.#server(config, logger);
  }

  async #tenant(
    config: TenantTopologyConfig,
    logger: { info(message: string): void; warn(message: string): void },
  ): Promise<CryptoRuntime> {
    const client = createCryptoClient({
      url: config.tenant.url,
      partition: config.tenant.partition,
      token: config.tenant.token,
      ...(config.tenant.timeoutMs !== undefined ? { timeoutMs: config.tenant.timeoutMs } : {}),
      ...(config.tenant.retries !== undefined ? { retries: config.tenant.retries } : {}),
    });
    let lastCheckAt: string | undefined;
    let lastError: string | undefined;
    if (config.tenant.checkOnBoot !== false) {
      try {
        await client.whoami();
        lastCheckAt = new Date().toISOString();
        logger.info(
          `[@adonis-agora/crypto] tenant ${config.tenant.partition} on ${config.tenant.url}`,
        );
      } catch (error) {
        lastError = (error as Error).message;
        logger.warn(
          `[@adonis-agora/crypto] ${config.tenant.partition} could not reach ${config.tenant.url}: ${lastError}`,
        );
      }
    }
    const operations = remoteOperations(client);
    const runtime: CryptoRuntime = {
      topology: 'tenant',
      partition: config.tenant.partition,
      client,
      operations,
      status: () => ({
        topology: 'tenant',
        partition: config.tenant.partition,
        mode: 'remote',
        ...(lastCheckAt !== undefined ? { lastCheckAt } : {}),
        ...(lastError !== undefined ? { lastError } : {}),
      }),
    };
    this.#runtime = runtime;
    setRuntime(runtime);
    return runtime;
  }

  async #server(
    config: StandaloneConfig | ControlPlaneConfig,
    logger: { info(message: string): void; warn(message: string): void },
  ): Promise<CryptoRuntime> {
    const container = this.app.container;
    const keyring = await this.#keyring(config.crypto);
    const autoCreateSchema = config.autoCreateSchema ?? true;
    const factoryContext: FactoryContext = {
      autoCreateSchema,
      async db(connection?: string) {
        if (!container.hasBinding('lucid.db')) {
          throw new Error(
            '[@adonis-agora/crypto] the lucid store needs @adonisjs/lucid configured, or set `store: stores.memory()`',
          );
        }
        const db = (await container.make('lucid.db')) as unknown as {
          connection(name?: string): SqlDatabase;
        };
        return inSchema(db.connection(connection), (config as { schema?: string }).schema);
      },
    };
    const store: CryptoStore = await (config.store ?? stores.lucid())(factoryContext);
    await store.setup?.();
    const service = new CryptoService({
      store,
      keyring,
      ...(config.maxBatchSize !== undefined ? { maxBatchSize: config.maxBatchSize } : {}),
    });
    const partition = config.topology === 'standalone' ? (config.app ?? '') : '';
    let api: CryptoApi | undefined;
    if (config.topology === 'control-plane') {
      const verifyTenant = await resolveTenantVerifier(config.verifyTenant);
      api = new CryptoApi({
        service,
        verifyTenant,
        ...(config.prefix !== undefined ? { prefix: config.prefix } : {}),
        ...(config.corsOrigins !== undefined ? { corsOrigins: config.corsOrigins } : {}),
        logger,
      });
    }
    const operations = localOperations(service, {
      partition,
      capabilities: ['crypto:*'],
      actor: partition === '' ? 'server' : `app:${partition}`,
    });
    const runtime: CryptoRuntime = {
      topology: config.topology ?? 'standalone',
      partition,
      store,
      service,
      ...(api !== undefined ? { api } : {}),
      operations,
      status: () => ({
        topology: config.topology ?? 'standalone',
        partition,
        mode: 'local',
        lastCheckAt: new Date().toISOString(),
      }),
    };
    this.#runtime = runtime;
    setRuntime(runtime);
    logger.info(
      `[@adonis-agora/crypto] ${config.topology ?? 'standalone'}${api ? ` at ${api.prefix}/v1` : ''}`,
    );
    return runtime;
  }

  /**
   * Where key material is sealed. Default: the app's own encryption service
   * (`config/encryption.ts`), so an app that configures nothing keeps working. `crypto.keys` lets
   * this package own the keys; `crypto.kms` makes a cloud KMS the root of an envelope. Without any
   * usable root the server refuses to boot: key material is never stored in plain text.
   */
  async #keyring(options: CryptoKeyringConfig | undefined): Promise<Keyring> {
    if (options?.keys?.length || options?.encryption) {
      return createCryptoKeyring({
        ...(options.keys ? { keys: options.keys } : {}),
        ...(options.active ? { active: options.active } : {}),
        ...(options.encryption ? { encryption: options.encryption } : {}),
        ...(options.kms ? { kms: options.kms } : {}),
      });
    }
    const encryption = await this.#appEncryption();
    if (encryption) {
      return createCryptoKeyring({
        encryption,
        ...(options?.kms ? { kms: options.kms } : {}),
      });
    }
    try {
      return createCryptoKeyring({
        appKey: process.env.APP_KEY,
        ...(options?.kms ? { kms: options.kms } : {}),
      });
    } catch {
      throw new Error(
        '[@adonis-agora/crypto] no keyring to seal key material: set up config/encryption.ts, set APP_KEY, or pass `crypto.keys` / `crypto.kms` in config/crypto.ts',
      );
    }
  }

  /** The app's `encryption` service (`config/encryption.ts`), when the app configured one. */
  async #appEncryption(): Promise<EncrypterLike | undefined> {
    try {
      if (!this.app.container.hasBinding('encryption')) return undefined;
      return (await this.app.container.make('encryption')) as EncrypterLike;
    } catch {
      return undefined;
    }
  }

  async #logger(): Promise<{ info(message: string): void; warn(message: string): void }> {
    try {
      const logger = (await this.app.container.make('logger')) as {
        info(message: string): void;
        warn(message: string): void;
      };
      return logger;
    } catch {
      return { info: () => {}, warn: () => {} };
    }
  }

  async boot(): Promise<void> {
    const runtime = await this.#build();
    await this.app.booted(async () => {
      if (!runtime.api) return;
      const router = await this.app.container.make('router');
      runtime.api.register(router as never);
    });
  }

  async shutdown(): Promise<void> {
    setRuntime(undefined);
    this.#runtime = undefined;
    this.#building = undefined;
  }
}
