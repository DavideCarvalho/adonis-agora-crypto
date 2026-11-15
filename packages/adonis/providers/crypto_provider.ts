import { fileURLToPath } from 'node:url';
import { createCryptoClient, type EnvelopeCipher } from '@adonis-agora/crypto-core';
import type { HttpContext } from '@adonisjs/core/http';
import type { ApplicationService } from '@adonisjs/core/types';
import { createCryptoKeyring, type EncrypterLike, type Keyring } from '../src/crypto/keyring.js';
import { CryptoService } from '../src/crypto/service.js';
import { CryptoConsole, cryptoConsoleSearchFor } from '../src/dashboard/console.js';
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
  type FactoryContext,
  type StandaloneConfig,
  stores,
  type TenantTopologyConfig,
} from '../src/define_config.js';
import { registerCryptoDevTools } from '../src/dev_tools.js';
import { registerDoctorChecks } from '../src/doctor/agora_doctor.js';
import { agoraDoctorChecks } from '../src/doctor/checks.js';
import { CryptoApi } from '../src/http/api.js';
import { serviceCipher } from '../src/http/envelope.js';
import { envelopeSkipPaths } from '../src/http/envelope_global.js';
import { localOperations, remoteOperations, transportOperations } from '../src/operations.js';
import type { CryptoRuntime } from '../src/runtime.js';
import { setRuntime } from '../src/services/accessor.js';
import { inSchema, type SqlDatabase } from '../src/sql.js';
import type { CryptoStore } from '../src/store/store.js';
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
    const transport = config.tenant.transport
      ? asCryptoTransport(config.tenant.transport)
      : undefined;
    const operations = transport
      ? transportOperations(transport, config.tenant.token)
      : remoteOperations(client);
    let lastCheckAt: string | undefined;
    let lastError: string | undefined;
    if (config.tenant.checkOnBoot !== false) {
      try {
        await (transport ? operations.whoami() : client.whoami());
        lastCheckAt = new Date().toISOString();
        logger.info(
          `[@adonis-agora/crypto] tenant ${config.tenant.partition} on ${transport ? `${transport.name} transport` : config.tenant.url}`,
        );
      } catch (error) {
        lastError = (error as Error).message;
        logger.warn(
          `[@adonis-agora/crypto] ${config.tenant.partition} could not reach ${config.tenant.url}: ${lastError}`,
        );
      }
    }
    const runtime: CryptoRuntime = {
      topology: 'tenant',
      partition: config.tenant.partition,
      client,
      operations,
      operationsFor: () => operations,
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
    this.#consoleConfig = resolveDashboardConfig(config.console);
    const service = new CryptoService({
      store,
      keyring,
      ...(config.maxBatchSize !== undefined ? { maxBatchSize: config.maxBatchSize } : {}),
    });
    const partition = config.topology === 'standalone' ? (config.app ?? '') : '';
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
    const console = new CryptoConsole({
      service,
      config,
      spaDir: spaDirectory(),
      ...(this.#runtime?.partition ? { defaultPartition: this.#runtime.partition } : {}),
      inProduction: this.app.inProduction,
      ...(registry ? { registry } : {}),
      topology: this.#runtime?.topology === 'standalone' ? 'standalone' : 'control-plane',
      logger,
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
        search: cryptoConsoleSearchFor(service, config.path),
      },
      logger,
    );
  }

  async #registerDevTools(): Promise<void> {
    const service = this.#runtime?.service;
    if (!service) return;
    await registerCryptoDevTools(this.app.container, {
      service,
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
    const installed = await installCryptoEnvelope({
      config: envelope,
      outboundCipher: cipher,
      inboundCipher: cipher,
      skipPaths: envelopeSkipPaths(config),
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
      const partition = config.topology === 'tenant' ? config.tenant.partition : undefined;
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
      (config.topology === 'standalone' ? (config as StandaloneConfig).app : undefined);
    if (!partition) {
      throw new Error(
        'crypto: `envelope.partition` is required on a control plane (the app whose keys hold the shared key)',
      );
    }
    return serviceCipher(runtime.service, partition, 'envelope');
  }

  async shutdown(): Promise<void> {
    await this.#runtime?.stopTransport?.().catch(() => {});
    setRuntime(undefined);
    this.#runtime = undefined;
    this.#building = undefined;
    this.#consoleConfig = undefined;
  }
}
