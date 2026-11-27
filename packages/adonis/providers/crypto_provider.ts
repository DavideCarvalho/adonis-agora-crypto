import { fileURLToPath } from 'node:url';
import {
  CRYPTO_RESOURCE,
  createCryptoClient,
  type EnvelopeCipher,
} from '@adonis-agora/crypto-core';
import type { HttpContext } from '@adonisjs/core/http';
import type { ApplicationService } from '@adonisjs/core/types';
import { createCryptoKeyring, type EncrypterLike, type Keyring } from '../src/crypto/keyring.js';
import { CryptoService } from '../src/crypto/service.js';
import { CryptoConsole, cryptoConsoleSearchFor } from '../src/dashboard/console.js';
import { consoleAppAllowed } from '../src/dashboard/console_apps.js';
import {
  type ConsoleAuthorizeDecision,
  resolveConsoleAuthorize,
} from '../src/dashboard/console_authorize.js';
import { readAgoraConsoles, registerAgoraConsole } from '../src/dashboard/console_switcher.js';
import {
  type ResolvedConsoleConfig,
  resolveDashboardConfig,
} from '../src/dashboard/define_config.js';
import {
  type ControlPlaneConfig,
  type CryptoConfig,
  type CryptoKeyringConfig,
  dataKeyStores,
  type FactoryContext,
  type StandaloneConfig,
  stores,
  type TenantTopologyConfig,
} from '../src/define_config.js';
import { registerCryptoDevTools } from '../src/dev_tools.js';
import { registerDoctorChecks } from '../src/doctor/agora_doctor.js';
import { agoraDoctorChecks } from '../src/doctor/checks.js';
import {
  CONSOLE_COMMAND_KEY,
  commandKeyOpener,
  cryptoConsoleCommandHandler,
  ensureConsoleCommandKey,
  FederatedCryptoApps,
  validateFederatedCryptoApp,
} from '../src/federation/console.js';
import {
  type AppCommandModes,
  type AuthkitClientLike,
  appUnauthenticatedMessage,
  authkitClientOf,
  ConsoleAuthConfigError,
  consoleUnauthenticatedMessage,
  ensureConsoleCryptoKey,
  resolveAppCommandModes,
  resolveConsoleSideMode,
  tokenUnavailableLog,
} from '../src/federation/console_modes.js';
import {
  CONSOLE_CRYPTO_KEY,
  RedisConsoleChannel,
  redisConnectionsOf,
  resolveRedisConnection,
} from '../src/federation/redis_channel.js';
import { CryptoApi } from '../src/http/api.js';
import { serviceCipher } from '../src/http/envelope.js';
import { envelopeSkipPaths } from '../src/http/envelope_global.js';
import { localOperations, remoteOperations, transportOperations } from '../src/operations.js';
import type { CryptoRuntime } from '../src/runtime.js';
import { setRuntime } from '../src/services/accessor.js';
import { inSchema, type SqlDatabase } from '../src/sql.js';
import type { CryptoStore } from '../src/store/store.js';
import { SubjectKeys } from '../src/subjects/subject_keys.js';
import { resolveTenantFields, tenantMissingMessage } from '../src/topology/tenant_auto.js';
import { resolveTenantVerifier } from '../src/topology/verify.js';
import { asCryptoTransport, serveBroker } from '../src/transports/broker.js';
import { createCryptoRpc } from '../src/transports/rpc.js';

declare module '@adonisjs/core/types' {
  interface ContainerBindings {
    'agora.crypto': CryptoRuntime;
  }
}

/** This console's id in the `'agora.consoles'` registry. */
export const CONSOLE_ID = 'crypto';

/** The built console (`dist/assets/spa`), resolved from `dist/providers/crypto_provider.js`. */
function spaDirectory(): string {
  return fileURLToPath(new URL('../assets/spa/', import.meta.url));
}

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
  #consoleConfig: ResolvedConsoleConfig | undefined;
  /** The other apps the console shows (`console.federatedApps`). */
  #federated: FederatedCryptoApps | undefined;
  /** The channel this app answers other consoles on (`consoleCommands`). */
  #consoleChannel: RedisConsoleChannel | undefined;

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
    const runtime =
      config.topology === 'tenant'
        ? await this.#tenant(config, logger)
        : await this.#server(config, logger);
    await this.#subjects(config, runtime);
    return runtime;
  }

  async #tenant(
    config: TenantTopologyConfig,
    logger: { info(message: string): void; warn(message: string): void },
  ): Promise<CryptoRuntime> {
    const tenant = config.tenant ?? {};
    // url, token and partition: `config/crypto.ts` first, then authkit-client's discovery.
    const fields = await resolveTenantFields(this.app.container, tenant, CRYPTO_RESOURCE);
    let missingMessage: string | undefined;
    if (fields.missing.length > 0) {
      missingMessage = tenantMissingMessage(fields);
      // A web process refuses to boot; ace, the REPL and tests boot and fail on the first call.
      if (this.app.getEnvironment() === 'web') throw new Error(missingMessage);
      logger.warn(missingMessage);
    }
    const unavailable = async (): Promise<string> => {
      throw new Error(missingMessage);
    };
    const url = fields.url ?? unavailable;
    const token = fields.token ?? unavailable;
    const partition = fields.partition ?? '';
    const client = createCryptoClient({
      url,
      // Never sent without a partition: the url and token above throw first.
      partition: partition || 'unconfigured',
      token,
      ...(tenant.timeoutMs !== undefined ? { timeoutMs: tenant.timeoutMs } : {}),
      ...(tenant.retries !== undefined ? { retries: tenant.retries } : {}),
    });
    const transport = tenant.transport ? asCryptoTransport(tenant.transport) : undefined;
    const operations = transport ? transportOperations(transport, token) : remoteOperations(client);
    let lastCheckAt: string | undefined;
    let lastError: string | undefined;
    if (tenant.checkOnBoot !== false && !missingMessage) {
      try {
        await (transport ? operations.whoami() : client.whoami());
        lastCheckAt = new Date().toISOString();
        logger.info(
          `[@adonis-agora/crypto] tenant ${partition} on ${transport ? `${transport.name} transport` : client.url}`,
        );
      } catch (error) {
        lastError = (error as Error).message;
        logger.warn(
          `[@adonis-agora/crypto] ${partition} could not reach ${client.url || 'the crypto server'}: ${lastError}`,
        );
      }
    }
    const runtime: CryptoRuntime = {
      topology: 'tenant',
      partition,
      client,
      tenant: {
        ...(fields.url !== undefined ? { url: fields.url } : {}),
        ...(fields.token !== undefined ? { token: fields.token } : {}),
        partition,
        sources: fields.sources,
        missing: fields.missing,
      },
      operations,
      operationsFor: () => operations,
      status: () => ({
        topology: 'tenant',
        partition,
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
    const keyring = await this.#keyring(config.crypto);
    const factoryContext = this.#factoryContext(
      config.autoCreateSchema ?? true,
      (config as { schema?: string }).schema,
    );
    const store: CryptoStore = await (config.store ?? stores.lucid())(factoryContext);
    await store.setup?.();
    this.#consoleConfig = resolveDashboardConfig(config.console);
    const service = new CryptoService({
      store,
      keyring,
      ...(config.maxBatchSize !== undefined ? { maxBatchSize: config.maxBatchSize } : {}),
      ...(config.sealProvisioning !== undefined
        ? { sealProvisioning: config.sealProvisioning }
        : {}),
    });
    const partition =
      (config.topology ?? 'standalone') === 'standalone'
        ? ((config as StandaloneConfig).app ?? '')
        : '';
    let api: CryptoApi | undefined;
    let verifyTenant: Awaited<ReturnType<typeof resolveTenantVerifier>> | undefined;
    if (config.topology === 'control-plane') {
      verifyTenant = await resolveTenantVerifier(config.verifyTenant);
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
      ...(verifyTenant !== undefined ? { verifyTenant } : {}),
      operations,
      operationsFor: (app, actor) =>
        localOperations(service, { partition: app, capabilities: ['crypto:*'], actor }),
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
    if (api && verifyTenant && config.topology === 'control-plane' && config.transport) {
      await this.app.booted(async () => {
        runtime.stopTransport = await serveBroker(
          config.transport!,
          createCryptoRpc({ service, verifyTenant, logger }),
          {
            deadLetter: async (_message, reason) =>
              logger.warn(
                `[@adonis-agora/crypto] dead-lettered a ${config.transport!.name} message: ${reason}`,
              ),
          },
        );
        logger.info(`[@adonis-agora/crypto] consuming the ${config.transport!.name} transport`);
      });
    }
    return runtime;
  }

  /** What store factories receive: the app's Lucid connection, bound to a schema when asked. */
  #factoryContext(autoCreateSchema: boolean, defaultSchema: string | undefined): FactoryContext {
    const container = this.app.container;
    return {
      autoCreateSchema,
      async db(connection?: string, schema?: string) {
        if (!container.hasBinding('lucid.db')) {
          throw new Error(
            '[@adonis-agora/crypto] the lucid store needs @adonisjs/lucid configured, or use a memory store (`stores.memory()` / `dataKeyStores.memory()`)',
          );
        }
        const db = (await container.make('lucid.db')) as unknown as {
          connection(name?: string): SqlDatabase;
        };
        return inSchema(db.connection(connection), schema ?? defaultSchema);
      },
      async dbResolver(connection?: string, schema?: string) {
        if (!container.hasBinding('lucid.db')) {
          throw new Error(
            '[@adonis-agora/crypto] the lucid store needs @adonisjs/lucid configured, or use a memory store (`dataKeyStores.memory()`)',
          );
        }
        const db = (await container.make('lucid.db')) as unknown as {
          connection(name?: string): SqlDatabase;
        };
        return () => inSchema(db.connection(connection), schema ?? defaultSchema);
      },
    };
  }

  /** `config.subjects`: the subject keys over this runtime's operations, in every topology. */
  async #subjects(config: CryptoConfig, runtime: CryptoRuntime): Promise<void> {
    const subjects = config.subjects;
    if (!subjects) return;
    const context = this.#factoryContext(
      config.topology === 'tenant' ? true : (config.autoCreateSchema ?? true),
      config.topology === 'tenant' ? undefined : (config as { schema?: string }).schema,
    );
    const store = await (subjects.store ?? dataKeyStores.lucid())(context);
    await store.setup?.();
    runtime.subjects = new SubjectKeys({
      operations: runtime.operations,
      store,
      ...(runtime.partition !== '' ? { app: runtime.partition } : {}),
      ...(subjects.cache !== undefined ? { cache: subjects.cache } : {}),
      ...(subjects.prefix !== undefined ? { prefix: subjects.prefix } : {}),
      ...(subjects.keyName !== undefined ? { keyName: subjects.keyName } : {}),
      ...(subjects.requireType !== undefined ? { requireType: subjects.requireType } : {}),
      ...(subjects.createKeys !== undefined ? { createKeys: subjects.createKeys } : {}),
    });
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

  /** Whether this viewer may operate on `app`: the console's static `apps`, then its grant. */
  async #appAllowed(ctx: HttpContext, app: string): Promise<boolean> {
    const decision = await this.#authorize(ctx);
    return decision.allowed && consoleAppAllowed(app, this.#consoleConfig?.apps, decision.apps);
  }

  /** The console's resolved gate, also used by the switcher and the dev tools. */
  async #authorize(ctx: HttpContext): Promise<ConsoleAuthorizeDecision> {
    const configured = this.#consoleConfig?.authorize;
    if (configured) return resolveConsoleAuthorize(configured)(ctx);
    return this.app.inProduction
      ? { allowed: false, status: 403, reason: 'forbidden' }
      : { allowed: true };
  }

  async #mountConsole(logger: {
    warn(message: string): void;
    info(message: string): void;
  }): Promise<void> {
    const config = this.#consoleConfig;
    const service = this.#runtime?.service;
    if (!config?.enabled || !service) return;
    const registry = await readAgoraConsoles(this.app.container);
    if (config.federatedApps) {
      const redisConnections = redisConnectionsOf(this.app.config);
      for (const [key, entry] of Object.entries(config.federatedApps)) {
        validateFederatedCryptoApp(key, entry, redisConnections);
      }
      const container = this.app.container;
      const web = this.app.getEnvironment() === 'web';
      const authkit = await this.#authkit();
      for (const [key, entry] of Object.entries(config.federatedApps)) {
        const mode = resolveConsoleSideMode(key, entry, { authkit, hasService: true });
        // A web process fails at boot, never on the first click; ace commands send nothing.
        if (mode.kind === 'unauthenticated' && web) {
          throw new ConsoleAuthConfigError(consoleUnauthenticatedMessage(key, entry));
        }
        if (web) {
          logger.info(`[@adonis-agora/crypto] console commands to "${key}": ${mode.describe}`);
        }
      }
      this.#federated = new FederatedCryptoApps(config.federatedApps, {
        service,
        onTokenUnavailable: (id, partition, reason) => {
          const { level, line } = tokenUnavailableLog(id, partition, reason);
          if (level === 'info') logger.info(line);
          else logger.warn(line);
        },
        ...(authkit ? { authkit } : {}),
        onKeyCreated: (partition, key) =>
          logger.info(
            `[@adonis-agora/crypto] console commands: created the crypto key "${key}" in partition ${partition}`,
          ),
        async db(connection) {
          if (!container.hasBinding('lucid.db')) {
            throw new Error('the federated console reads other apps through @adonisjs/lucid');
          }
          const db = (await container.make('lucid.db')) as unknown as {
            connection(name?: string): SqlDatabase;
          };
          return db.connection(connection);
        },
        redis: (connection) => resolveRedisConnection(container, connection),
      });
    }
    const console = new CryptoConsole({
      service,
      config,
      spaDir: spaDirectory(),
      ...(this.#runtime?.partition ? { defaultPartition: this.#runtime.partition } : {}),
      inProduction: this.app.inProduction,
      ...(registry ? { registry } : {}),
      topology: this.#runtime?.topology === 'standalone' ? 'standalone' : 'control-plane',
      logger,
      ...(this.#federated ? { federated: this.#federated } : {}),
    });
    if (!config.authorize) {
      logger.warn(
        '[@adonis-agora/crypto] the console has no `authorize`: it is open outside production and denies every request in production. Set `console.authorize` in config/crypto.ts.',
      );
    }
    await this.app.booted(async () => {
      const router = await this.app.container.make('router');
      console.register(router as never);
    });
    logger.info(
      `[@adonis-agora/crypto] console at ${config.path === '' ? '/' : config.path} (API ${config.api})`,
    );
  }

  async #registerConsole(logger: { warn(message: string): void }): Promise<void> {
    const config = this.#consoleConfig;
    const service = this.#runtime?.service;
    if (!config?.enabled || !service) return;
    const path = config.path === '' ? '/' : config.path;
    await registerAgoraConsole(
      this.app.container,
      {
        id: CONSOLE_ID,
        title: 'Crypto keys',
        package: '@adonis-agora/crypto',
        icon: 'generic',
        path,
        order: 66,
        authorize: async (ctx) => {
          const decision = await this.#authorize(ctx);
          if (decision.allowed) return { allowed: true };
          if (decision.status === 302) {
            return { allowed: false, redirectTo: decision.redirectTo };
          }
          return { allowed: false, reason: decision.reason };
        },
        search: cryptoConsoleSearchFor(service, config.path, (ctx, app) =>
          this.#appAllowed(ctx, app),
        ),
      },
      logger,
    );
  }

  async #registerDevTools(): Promise<void> {
    const service = this.#runtime?.service;
    if (!service) return;
    await registerCryptoDevTools(this.app.container, {
      service,
      appAllowed: (ctx, app) => this.#appAllowed(ctx, app),
      authorize: async (ctx) => {
        const decision = await this.#authorize(ctx);
        if (decision.allowed) return { allowed: true };
        if (decision.status === 302) {
          return { allowed: false, reason: 'forbidden', redirectTo: decision.redirectTo };
        }
        return { allowed: false, reason: decision.reason };
      },
    });
  }

  async boot(): Promise<void> {
    const runtime = await this.#build();
    const logger = await this.#logger();
    await registerDoctorChecks(this.app.container, agoraDoctorChecks);
    if (runtime.topology !== 'tenant') {
      await this.#registerConsole(logger);
      await this.#mountConsole(logger);
      // A console that is disabled exposes no dev tools either (the hub rule every Agora lib follows).
      if (this.#consoleConfig?.enabled) await this.#registerDevTools();
    }
    await this.#installEnvelope(runtime, logger);
    await this.#resolveConsoleCommands();
    // Console side: the console-crypto keys exist before the first command (web only).
    if (this.app.getEnvironment() === 'web') await this.#ensureConsoleCryptoKeys();
    await this.app.booted(async () => {
      if (!runtime.api) return;
      const router = await this.app.container.make('router');
      runtime.api.register(router as never);
    });
  }

  /**
   * Wires app-to-app encryption from `config/crypto.ts` — the only configuration it takes. The
   * outbound interceptor is composed onto the global dispatcher (never replacing it, so telescope and
   * authkit-client keep their interceptors in the chain); the inbound middleware is registered on the
   * **server** stack here, so no app needs to edit `start/kernel.ts`.
   */
  async #installEnvelope(
    runtime: CryptoRuntime,
    logger: { info(message: string): void; warn(message: string): void },
  ): Promise<void> {
    const config = this.#config();
    const envelope = config.envelope;
    if (!envelope) return;
    const cipher = this.#envelopeCipher(config, runtime);
    const { installCryptoEnvelope } = await import('../src/http/envelope_global.js');
    // A lazy tenant URL is resolved here, so calls to the crypto server itself are never sealed.
    let tenantUrl: string | undefined;
    if (config.topology === 'tenant' && typeof runtime.tenant?.url === 'function') {
      tenantUrl = await runtime.client?.resolveUrl().catch((error: Error) => {
        logger.warn(
          `[@adonis-agora/crypto] envelope: the crypto server URL did not resolve (${error.message}); only the default /_crypto path is left unsealed`,
        );
        return undefined;
      });
    }
    const installed = await installCryptoEnvelope({
      config: envelope,
      outboundCipher: cipher,
      inboundCipher: cipher,
      skipPaths: envelopeSkipPaths(
        config,
        tenantUrl ?? (typeof runtime.tenant?.url === 'string' ? runtime.tenant.url : undefined),
      ),
      warn: (message) => logger.warn(message),
    });
    if (!installed.inbound) return;
    try {
      const server = (await this.app.container.make('server')) as {
        use(middleware: unknown[]): unknown;
      };
      server.use([() => import('../src/http/envelope_global_middleware.js')]);
      runtime.envelope = installed.inbound;
    } catch (error) {
      // No HTTP server in this process (an ace command, a worker): outbound stays on, the inbound
      // half simply has nothing to attach to.
      logger.warn(
        `[@adonis-agora/crypto] envelope: inbound middleware not registered (${(error as Error).message}); outbound sealing stays on`,
      );
      return;
    }
    logger.info(
      `[@adonis-agora/crypto] envelope on ${envelope.key !== undefined ? `key "${envelope.key}"` : 'the accepted keys'} (inbound + outbound)`,
    );
  }

  /** The cipher each half uses: the app's own client on a tenant, the service in process on a server. */
  #envelopeCipher(config: CryptoConfig, runtime: CryptoRuntime): EnvelopeCipher {
    if (runtime.client) {
      const partition = config.topology === 'tenant' ? runtime.partition : undefined;
      if (config.envelope?.partition !== undefined && config.envelope.partition !== partition) {
        throw new Error(
          `crypto: envelope.partition cannot differ from tenant.partition ("${config.envelope.partition}" ≠ "${partition}") — a tenant's keys are the token's partition`,
        );
      }
      return runtime.client;
    }
    if (!runtime.service) {
      throw new Error('crypto: an envelope needs a booted crypto runtime');
    }
    const partition =
      config.envelope?.partition ??
      ((config.topology ?? 'standalone') === 'standalone'
        ? (config as StandaloneConfig).app
        : undefined);
    if (!partition) {
      throw new Error(
        'crypto: `envelope.partition` is required on a control plane (the app whose keys hold the shared key)',
      );
    }
    return serviceCipher(runtime.service, partition, 'envelope');
  }

  /**
   * Answer another app's federated crypto console (`consoleCommands` in config/crypto.ts). Web
   * processes only: a short-lived `ace` command that won a command's claim could exit before it
   * answers. A connection that cannot claim a command (no `SET NX`) answers nothing, and says so.
   */
  async ready(): Promise<void> {
    const config = this.app.config.get<CryptoConfig | undefined>('crypto');
    if (!config || config.topology === 'tenant') return;
    if (this.app.getEnvironment() !== 'web') return;
    const options = config.consoleCommands;
    if (!options) return;
    const logger = await this.#logger();
    const service = this.#runtime?.service;
    if (!service) return;
    const modes = this.#appModes;
    if (!modes) return;
    const { sealedToApp } = modes;
    try {
      // Never "every partition" by default: a control plane (no app of its own) lists them.
      const partitions =
        options.partitions ?? (this.#runtime?.partition ? [this.#runtime.partition] : []);
      if (partitions.length === 0) {
        logger.warn(
          '[@adonis-agora/crypto] consoleCommands: no `partitions` and no app of its own, so this app answers for none; list them in consoleCommands.partitions',
        );
      }
      if (sealedToApp) {
        // The console seals each command (and its token) to the public half of this key, read
        // from this app's store, never from Redis.
        // Never fails the boot: a missing key only refuses token-mode commands until it exists.
        for (const partition of partitions) {
          try {
            const made = await ensureConsoleCommandKey(service, partition);
            if (made === 'created') {
              logger.info(
                `[@adonis-agora/crypto] console commands: created ${partition}/${CONSOLE_COMMAND_KEY} (token mode)`,
              );
            }
          } catch (error) {
            logger.warn(
              `[@adonis-agora/crypto] console commands: could not create ${partition}/${CONSOLE_COMMAND_KEY} (${error instanceof Error ? error.message : String(error)}); run \`node ace crypto:keys:create ${CONSOLE_COMMAND_KEY} --type x25519 --application ${partition}\``,
            );
          }
        }
      }
      const channel = new RedisConsoleChannel({
        client: await resolveRedisConnection(this.app.container, options.connection),
        prefix: options.prefix,
        ...(modes.secret !== undefined ? { secret: modes.secret } : {}),
        ...(modes.crypto !== undefined ? { crypto: modes.crypto } : {}),
        ...(modes.cryptoToken !== undefined ? { cryptoToken: modes.cryptoToken } : {}),
        ...(modes.verifyTenant !== undefined ? { verifyTenant: modes.verifyTenant } : {}),
        ...(modes.verifyAppCall !== undefined ? { verifyAppCall: modes.verifyAppCall } : {}),
        ...(sealedToApp ? { opener: commandKeyOpener(service, partitions) } : {}),
      });
      const seen = new Set<unknown>();
      await channel.answer(
        cryptoConsoleCommandHandler({
          service,
          actions: options.actions === true,
          ...(options.capabilities ? { capabilities: options.capabilities } : {}),
          partitions,
          protectedKeys: [
            CONSOLE_COMMAND_KEY,
            ...(modes.crypto ? [modes.crypto.key ?? CONSOLE_CRYPTO_KEY] : []),
          ],
          log: (line) => logger.info(line),
        }),
        {
          // Logged once per reason (a flood of garbage logs one line), then dropped.
          onRefused: (reason) => {
            if (seen.has(reason)) return;
            if (seen.size < 100) seen.add(reason);
            logger.warn(`[@adonis-agora/crypto] console commands: refused a command (${reason})`);
          },
          onError: (error) => {
            const message = error instanceof Error ? error.message : String(error);
            const reason = (error as { code?: unknown })?.code ?? message;
            if (seen.has(reason)) return;
            if (seen.size < 100) seen.add(reason);
            logger.warn(`[@adonis-agora/crypto] federated console command dropped: ${message}`);
          },
        },
      );
      this.#consoleChannel = channel;
      // The command key as a short id only (its public half is in this app's store).
      const sealedTo = sealedToApp
        ? (
            await Promise.all(
              partitions.map(async (partition) => {
                const record = await service.store.getKey(partition, CONSOLE_COMMAND_KEY);
                const version = record
                  ? await service.store.version(
                      partition,
                      CONSOLE_COMMAND_KEY,
                      record.latestVersion,
                    )
                  : null;
                const kid = version?.publicKey?.kid;
                return `key ${kid ? kid.slice(0, 8) : '(not created yet)'}`;
              }),
            )
          ).join(', ')
        : '';
      const line = modes.modes.map((mode) => mode.replace('{sealedTo}', sealedTo)).join(' + ');
      logger.info(
        `[@adonis-agora/crypto] console commands: ${line}; ${options.actions === true ? 'actions on' : 'actions off (set consoleCommands.actions to let the console act)'}`,
      );
      if (sealedToApp && partitions[0] !== undefined) {
        logger.info(
          `[@adonis-agora/crypto] console commands: the full public key: node ace crypto:keys:public-key ${CONSOLE_COMMAND_KEY} --application ${partitions[0]}`,
        );
      }
    } catch (error) {
      logger.warn(
        `[@adonis-agora/crypto] consoleCommands is on, but ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  #authkitClient: Promise<AuthkitClientLike | undefined> | undefined;
  /** What `consoleCommands` accepts, resolved in `boot()` (web only) and started in `ready()`. */
  #appModes: AppCommandModes | undefined;

  /**
   * `consoleCommands`, resolved at boot of a web process so a misconfiguration fails before the
   * HTTP server listens (Adonis runs `ready()` after that). Other environments start no channel.
   */
  async #resolveConsoleCommands(): Promise<void> {
    this.#appModes = undefined;
    const config = this.app.config.get<CryptoConfig | undefined>('crypto');
    if (!config || config.topology === 'tenant' || !config.consoleCommands) return;
    if (this.app.getEnvironment() !== 'web') return;
    const modes = resolveAppCommandModes(config, { authkit: await this.#authkit() });
    if (!modes || modes.modes.length === 0)
      throw new ConsoleAuthConfigError(appUnauthenticatedMessage(config));
    this.#appModes = modes;
  }

  /**
   * `@adonis-agora/authkit-client`, when this app boots it (detected, never imported). One that is
   * installed but fails to boot fails a web process (its tokens were meant to authenticate console
   * commands); elsewhere it is ignored.
   */
  #authkit(): Promise<AuthkitClientLike | undefined> {
    this.#authkitClient ??= authkitClientOf(this.app.container).catch((error: unknown) => {
      if (this.app.getEnvironment() === 'web') throw error;
      return undefined;
    });
    return this.#authkitClient;
  }

  /**
   * Console side, automatic crypto mode: each federated app's `console-crypto` key, created in its
   * partition of this server at boot (web only) so the app can be granted it and the doctor finds
   * it. Best effort: the first command creates it too.
   */
  async #ensureConsoleCryptoKeys(): Promise<void> {
    const apps = this.#consoleConfig?.enabled ? this.#consoleConfig.federatedApps : undefined;
    const service = this.#runtime?.service;
    if (!apps || !service) return;
    const logger = await this.#logger();
    for (const [key, entry] of Object.entries(apps)) {
      const mode = resolveConsoleSideMode(key, entry, { hasService: true });
      if (mode.kind !== 'crypto-auto') continue;
      try {
        if ((await ensureConsoleCryptoKey(service, mode.partition, mode.key)) === 'created') {
          logger.info(
            `[@adonis-agora/crypto] console commands: created the crypto key "${mode.key}" in partition ${mode.partition}`,
          );
        }
      } catch (error) {
        logger.warn(
          `[@adonis-agora/crypto] console commands to "${key}": could not create ${mode.partition}/${mode.key} (${error instanceof Error ? error.message : String(error)}); it is retried on the first command, or run \`node ace crypto:keys:create ${mode.key} --type aes256-gcm --application ${mode.partition}\``,
        );
      }
    }
  }

  async shutdown(): Promise<void> {
    await this.#consoleChannel?.close();
    this.#consoleChannel = undefined;
    await this.#federated?.close();
    this.#federated = undefined;
    await this.#runtime?.stopTransport?.().catch(() => {});
    this.#runtime?.subjects?.clear();
    setRuntime(undefined);
    this.#runtime = undefined;
    this.#building = undefined;
    this.#consoleConfig = undefined;
    this.#authkitClient = undefined;
    this.#appModes = undefined;
  }
}
