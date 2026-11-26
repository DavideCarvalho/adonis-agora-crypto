import { randomUUID } from 'node:crypto';
import { createCryptoClient } from '@adonis-agora/crypto-core';
import type { ApplicationService } from '@adonisjs/core/types';
import { openMaterial } from '../crypto/material.js';
import { materialStatus } from '../crypto/reseal.js';
import type { CryptoService } from '../crypto/service.js';
import { resolveDashboardConfig } from '../dashboard/define_config.js';
import type { CryptoConfig, TenantTopologyConfig } from '../define_config.js';
import { CONSOLE_COMMAND_KEY } from '../federation/console.js';
import {
  appUnauthenticatedMessage,
  authkitClientOf,
  consoleUnauthenticatedMessage,
  resolveAppCommandModes,
  resolveConsoleSideMode,
} from '../federation/console_modes.js';
import { CONSOLE_CRYPTO_KEY, type ConsoleCipherSource } from '../federation/redis_channel.js';
import type { CryptoRuntime } from '../runtime.js';
import { getRuntime, hasRuntime } from '../services/accessor.js';
import { legacyPlaintextColumns, legacyPlaintextReads } from '../subjects/lucid.js';
import type { AgoraDoctorCheck, AgoraDoctorResult } from './agora_doctor.js';

const DOCS = 'https://davidecarvalho.github.io/agora/docs/crypto';

function configOf(app: ApplicationService): CryptoConfig | null {
  // `node ace agora:doctor --no-boot` never loads the app's config: every check must skip, not throw.
  try {
    return app.config?.get?.<CryptoConfig>('crypto') ?? null;
  } catch {
    return null;
  }
}

function tenantConfig(app: ApplicationService): TenantTopologyConfig | null {
  const config = configOf(app);
  return config?.topology === 'tenant' ? config : null;
}

function runtimeOf(): CryptoRuntime | null {
  return hasRuntime() ? getRuntime() : null;
}

/** `--no-boot` (or a boot that failed): the config is not loaded, so the check has nothing to read. */
function notBooted(): AgoraDoctorResult {
  return {
    status: 'skip',
    message: 'The app is not booted: run without `--no-boot` to check the crypto configuration.',
  };
}

/**
 * The crypto checks: is there a keyring to seal material, does every version still open, is a
 * tenant's token accepted, and is the console gated in production. `agora:doctor` runs them;
 * cheap checks read config, deep ones touch the store or the network (`--deep`).
 */
export const agoraDoctorChecks: AgoraDoctorCheck[] = [
  {
    id: 'crypto.keyring',
    lib: 'crypto',
    title: 'Key material keyring',
    run: async (app): Promise<AgoraDoctorResult> => {
      const config = configOf(app);
      if (!config) return notBooted();
      if (config.topology === 'tenant') {
        return {
          status: 'skip',
          message: 'This process holds no keys: it is a tenant (the server seals them).',
        };
      }
      const runtime = runtimeOf();
      if (!runtime || runtime.topology === 'tenant') {
        return {
          status: 'skip',
          message: 'The crypto provider is not booted in this process.',
        };
      }
      if (!runtime.service) {
        return {
          status: 'error',
          message: 'No service: the provider did not build a server runtime.',
          fix: 'Check that the crypto provider is registered in adonisrc.ts.',
          docs: `${DOCS}/getting-started`,
        };
      }
      if (config.crypto?.kms) {
        return {
          status: 'ok',
          message:
            'Key material is sealed with an envelope: a data key wrapped by the configured KMS.',
        };
      }
      if (config.crypto?.keys?.length) {
        return {
          status: 'ok',
          message: `Key material is sealed with ${config.crypto.keys.length} key(s) from \`crypto.keys\` (the first one seals).`,
        };
      }
      return {
        status: 'ok',
        message:
          'Key material is sealed with the app encryption service (config/encryption.ts), the default.',
        docs: `${DOCS}/keys`,
      };
    },
  },
  {
    id: 'crypto.database',
    lib: 'crypto',
    title: 'Keys in the store',
    cost: 'deep',
    run: async (): Promise<AgoraDoctorResult> => {
      const runtime = runtimeOf();
      if (!runtime?.store) {
        return {
          status: 'skip',
          message: 'No store in this process (tenant, or the provider is not booted).',
        };
      }
      const partitions = await runtime.store.partitions();
      let keys = 0;
      let deleted = 0;
      for (const partition of partitions) {
        for (const key of await runtime.store.listKeys(partition)) {
          if (key.deletedAt !== undefined) deleted += 1;
          else keys += 1;
        }
      }
      return {
        status: 'ok',
        message: `${keys} key(s) in ${partitions.length} app(s)${deleted > 0 ? `, ${deleted} deleted` : ''}.`,
        docs: `${DOCS}/keys`,
      };
    },
  },
  {
    id: 'crypto.key-material',
    lib: 'crypto',
    title: 'Every key version opens',
    cost: 'deep',
    run: async (): Promise<AgoraDoctorResult> => {
      const runtime = runtimeOf();
      if (!runtime?.service) {
        return { status: 'skip', message: 'No keys in this process (tenant).' };
      }
      const service = runtime.service;
      const unreadable: string[] = [];
      let checked = 0;
      for (const partition of (await runtime.store?.partitions()) ?? []) {
        for (const key of (await runtime.store?.listKeys(partition)) ?? []) {
          if (key.deletedAt !== undefined) continue;
          for (const version of await runtime.store!.versions(partition, key.name)) {
            checked += 1;
            try {
              await openMaterial(
                service.keyring,
                partition,
                key.name,
                version.version,
                key.type,
                version.sealed,
              );
            } catch {
              unreadable.push(`${partition}/${key.name}@v${version.version}`);
            }
          }
        }
      }
      if (unreadable.length > 0) {
        return {
          status: 'error',
          message: `${unreadable.length} of ${checked} key version(s) do not open: ${unreadable.slice(0, 5).join(', ')}${unreadable.length > 5 ? '…' : ''}`,
          fix: 'Restore the root keyring (APP_KEY / config/encryption.ts, `crypto.keys`, or the KMS) that sealed this material. Recovered data cannot be re-created otherwise.',
          docs: `${DOCS}/kms`,
        };
      }
      if (checked === 0) {
        return { status: 'ok', message: 'No key versions to check yet.' };
      }
      const statuses = await materialStatus(runtime.store!, service.keyring);
      if (statuses.retired > 0) {
        return {
          status: 'warn',
          message: `${statuses.retired} of ${checked} key version(s) are sealed with a retired root key.`,
          fix: 'Run `node ace crypto:keys:reseal` to move them to the active root key.',
          docs: `${DOCS}/keys`,
        };
      }
      return {
        status: 'ok',
        message: `All ${checked} key version(s) open with the configured root.`,
      };
    },
  },
  {
    id: 'crypto.tenant',
    lib: 'crypto',
    title: 'Crypto server reachable and token accepted',
    cost: 'deep',
    run: async (app): Promise<AgoraDoctorResult> => {
      if (configOf(app) === null) return notBooted();
      const config = tenantConfig(app);
      if (!config) {
        return {
          status: 'skip',
          message: 'This process is not a tenant: it serves keys instead of asking for them.',
        };
      }
      const client = createCryptoClient({
        url: config.tenant.url,
        partition: config.tenant.partition,
        token: config.tenant.token,
        retries: 0,
      });
      let url: string;
      try {
        url = await client.resolveUrl();
      } catch (error) {
        return {
          status: 'error',
          message: `The crypto server URL did not resolve: ${(error as Error).message}.`,
          fix: 'Check the `tenant.url` function (e.g. controlPlaneUrl: the issuer is up and lists urn:agora:crypto).',
          docs: `${DOCS}/deployment`,
        };
      }
      try {
        const who = await client.whoami();
        return {
          status: 'ok',
          message: `${client.url || url}: ${who.partition} with ${who.capabilities.join(', ') || 'no capabilities'}.`,
        };
      } catch (error) {
        const failure = error as { status?: number; message?: string };
        if (failure.status === 401) {
          return {
            status: 'error',
            message: 'The crypto server refused the tenant token (401).',
            fix: 'Check CRYPTO_TOKEN / the authkit client credentials, and that the client is registered for urn:agora:crypto.',
            docs: `${DOCS}/authentication`,
          };
        }
        if (failure.status === 403) {
          return {
            status: 'error',
            message: 'The token was accepted but holds no capability for this call (403).',
            fix: 'Grant the client the capabilities it needs (crypto:encrypt:<key>, …).',
            docs: `${DOCS}/authentication`,
          };
        }
        return {
          status: 'error',
          message: `${client.url || url} answered nothing: ${failure.message ?? 'unknown error'}.`,
          fix: 'Check CRYPTO_URL (including its /_crypto prefix) and that the crypto server is running.',
          docs: `${DOCS}/deployment`,
        };
      }
    },
  },
  {
    id: 'crypto.console',
    lib: 'crypto',
    title: 'Console gated in production',
    run: async (app): Promise<AgoraDoctorResult> => {
      const config = configOf(app);
      if (!config) return notBooted();
      if (config.topology === 'tenant') {
        return { status: 'skip', message: 'No console in this process.' };
      }
      if (config.console === false) {
        return { status: 'ok', message: 'The console is disabled.' };
      }
      if (config.console?.authorize) {
        return { status: 'ok', message: 'The console has an authorize hook.' };
      }
      return {
        status: app.inProduction ? 'error' : 'warn',
        message: app.inProduction
          ? 'The console has no `authorize`: every request is denied in production.'
          : 'The console has no `authorize`: it is open to anyone who reaches it outside production.',
        fix: 'Set `console.authorize` (authkitDashboardAuthorize, or your own predicate).',
        docs: `${DOCS}/console`,
      };
    },
  },
  {
    id: 'crypto.console-commands',
    lib: 'crypto',
    title: 'Console commands authenticated',
    run: async (app): Promise<AgoraDoctorResult | AgoraDoctorResult[]> => {
      const config = configOf(app);
      if (!config) return notBooted();
      if (config.topology === 'tenant') {
        return { status: 'skip', message: 'A tenant neither answers nor sends console commands.' };
      }
      const authkit = await authkitClientOf(app.container).catch(() => undefined);
      const results: AgoraDoctorResult[] = [];
      const modes = resolveAppCommandModes(config, { authkit });
      const sealedTo = modes?.sealedToApp ? await commandKeyIds(config) : '';
      if (modes) {
        results.push(
          modes.modes.length > 0
            ? {
                status: 'ok',
                message: `console commands: ${modes.modes.map((m) => m.replace('{sealedTo}', sealedTo)).join(' + ')}; ${config.consoleCommands?.actions === true ? 'actions on' : 'actions off (set consoleCommands.actions to let the console act)'}.`,
              }
            : {
                status: 'error',
                message: 'consoleCommands is set but accepts no authenticated command.',
                fix: appUnauthenticatedMessage(config),
                docs: `${DOCS}/federated-console#authenticating-the-console`,
              },
        );
      }
      const apps = resolveDashboardConfig(config.console).enabled
        ? resolveDashboardConfig(config.console).federatedApps
        : undefined;
      for (const [id, entry] of Object.entries(apps ?? {})) {
        const mode = resolveConsoleSideMode(id, entry, { authkit, hasService: true });
        results.push(
          mode.kind === 'unauthenticated'
            ? {
                status: 'error',
                message: `Commands to the federated app "${id}" are unauthenticated.`,
                fix: consoleUnauthenticatedMessage(id, entry),
                docs: `${DOCS}/federated-console#authenticating-the-console`,
              }
            : { status: 'ok', message: `console commands to "${id}": ${mode.describe}.` },
        );
      }
      if (results.length === 0) {
        return { status: 'skip', message: 'No consoleCommands and no console.federatedApps.' };
      }
      return results;
    },
  },
  {
    id: 'crypto.console-commands-key',
    lib: 'crypto',
    title: 'Console command keys usable',
    cost: 'deep',
    run: async (app): Promise<AgoraDoctorResult | AgoraDoctorResult[]> => {
      const config = configOf(app);
      if (!config) return notBooted();
      if (config.topology === 'tenant') {
        return { status: 'skip', message: 'A tenant neither answers nor sends console commands.' };
      }
      const runtime = runtimeOf();
      const service = runtime?.service;
      if (!service) {
        return { status: 'skip', message: 'The crypto provider is not booted in this process.' };
      }
      const results: AgoraDoctorResult[] = [];
      const docs = `${DOCS}/federated-console#authenticating-the-console`;
      // Console side: this server's console-crypto key in each federated app's partition.
      const apps = resolveDashboardConfig(config.console).enabled
        ? resolveDashboardConfig(config.console).federatedApps
        : undefined;
      for (const [id, entry] of Object.entries(apps ?? {})) {
        const mode = resolveConsoleSideMode(id, entry, { hasService: true });
        if (mode.kind !== 'crypto-auto') continue;
        const key = mode.key ?? CONSOLE_CRYPTO_KEY;
        if (!(await service.store.getKey(mode.partition, key))) {
          results.push({
            status: 'warn',
            message: `"${mode.partition}/${key}" does not exist yet: the web process creates it at boot.`,
            fix: `Start the web process once, or run \`node ace crypto:keys:create ${key} --type aes256-gcm --application ${mode.partition}\`.`,
            docs,
          });
          continue;
        }
        results.push(await probe(service, mode.partition, key, `commands to "${id}"`));
      }
      // App side: what this app opens commands with.
      const modes = resolveAppCommandModes(config);
      if (modes?.crypto) {
        const key = modes.crypto.key ?? CONSOLE_CRYPTO_KEY;
        results.push(await openCheck(modes.crypto.cipher, key));
      }
      if (modes?.sealedToApp && config.consoleCommands) {
        const partitions =
          config.consoleCommands.partitions ?? (runtime.partition ? [runtime.partition] : []);
        for (const partition of partitions) {
          const record = await service.store.getKey(partition, CONSOLE_COMMAND_KEY);
          results.push(
            record && record.type === 'x25519' && record.deletedAt === undefined
              ? {
                  status: 'ok',
                  message: `"${partition}/${CONSOLE_COMMAND_KEY}" is ready for token mode (full public key: node ace crypto:keys:public-key ${CONSOLE_COMMAND_KEY} --application ${partition}).`,
                }
              : {
                  status: 'warn',
                  message: `"${partition}/${CONSOLE_COMMAND_KEY}" does not exist yet: the web process creates it at boot.`,
                  fix: 'Start the web process once (token-mode consoles read its public half from this store).',
                  docs,
                },
          );
        }
      }
      if (results.length === 0) {
        return { status: 'skip', message: 'No console command key to check.' };
      }
      return results;
    },
  },
  {
    id: 'crypto.subjects',
    lib: 'crypto',
    title: 'Encrypted columns without plaintext fallback',
    run: async (app): Promise<AgoraDoctorResult> => {
      const config = configOf(app);
      if (!config) return notBooted();
      if (!config.subjects) {
        return { status: 'skip', message: 'No `subjects` in config/crypto.ts.' };
      }
      const columns = legacyPlaintextColumns();
      const reads = legacyPlaintextReads();
      if (columns.length > 0 || reads > 0) {
        return {
          status: 'warn',
          message: `\`legacyPlaintext\` is on${columns.length > 0 ? ` for ${columns.join(', ')}` : ''} (${reads} plaintext values read by this process): plaintext in those columns is served as data.`,
          fix: 'Finish `node ace crypto:subjects:backfill`, add the CHECK constraint (encryptedColumnCheck), then remove `legacyPlaintext`.',
          docs: `${DOCS}/subjects`,
        };
      }
      return {
        status: 'ok',
        message: 'No encrypted column accepts plaintext (among the models loaded by this process).',
      };
    },
  },
];

/** Encrypts and decrypts a probe with `key` in `partition` of this server (audited like any call). */
async function probe(
  service: CryptoService,
  partition: string,
  key: string,
  what: string,
): Promise<AgoraDoctorResult> {
  const principal = {
    partition,
    capabilities: [`crypto:encrypt:${key}`, `crypto:decrypt:${key}`],
    actor: 'agora:doctor',
  };
  try {
    const plaintext = randomUUID();
    const { ciphertext } = await service.encrypt(principal, { key, plaintext });
    const opened = await service.decrypt(principal, { key, ciphertext, context: 'doctor' });
    if (opened.plaintext !== plaintext) throw new Error('the probe did not round-trip');
    return { status: 'ok', message: `${what}: "${partition}/${key}" encrypts and decrypts.` };
  } catch (error) {
    return {
      status: 'error',
      message: `${what}: "${partition}/${key}" is not usable: ${(error as Error).message}.`,
      fix: 'Check the root keyring that sealed it (`crypto.key-material`), or delete and let the boot re-create it.',
      docs: `${DOCS}/federated-console#authenticating-the-console`,
    };
  }
}

/**
 * App side, explicit crypto: whether this app's cipher can open commands with `key`. A decrypt of
 * a well-formed but bogus ciphertext tells "no such key" and "not allowed" apart from "the key is
 * there and this client may use it" (which fails only on the ciphertext itself).
 */
async function openCheck(source: ConsoleCipherSource, key: string): Promise<AgoraDoctorResult> {
  const docs = `${DOCS}/federated-console#authenticating-the-console`;
  try {
    const cipher = typeof source === 'function' ? await source() : source;
    // `hasKey` when the cipher has it (no audit row); the decrypt probe otherwise.
    const hasKey = (cipher as { hasKey?: (input: { key: string }) => Promise<boolean> }).hasKey;
    const exists =
      typeof hasKey === 'function'
        ? await hasKey.call(cipher, { key }).catch((error: unknown) => {
            // Refused: reported below. Anything else (a server that predates it): probe.
            if (/forbidden|lacks|capabilit/i.test((error as Error)?.message ?? '')) throw error;
            return undefined;
          })
        : undefined;
    if (exists !== undefined) {
      if (exists) {
        return { status: 'ok', message: `consoleCommands can open commands with "${key}".` };
      }
      return {
        status: 'error',
        message: `The crypto server has no "${key}" key in this app's partition.`,
        fix: `Start the console (it creates it), or run \`node ace crypto:keys:create ${key} --type aes256-gcm --application <this app>\` on that server.`,
        docs,
      };
    }
    await cipher.decrypt({
      key,
      ciphertext: `agora:ct1:${key}:1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`,
      aad: 'agora:doctor',
      context: 'doctor',
    });
    return { status: 'ok', message: `consoleCommands opens commands with "${key}".` };
  } catch (error) {
    const message = (error as Error).message ?? String(error);
    if (/no key named|not[ _]found/i.test(message)) {
      return {
        status: 'error',
        message: `The crypto server has no "${key}" key in this app's partition.`,
        fix: `Start the console (it creates it), or run \`node ace crypto:keys:create ${key} --type aes256-gcm --application <this app>\` on that server.`,
        docs,
      };
    }
    if (/forbidden|lacks|capabilit/i.test(message)) {
      return {
        status: 'error',
        message: `This app's crypto client may not decrypt with "${key}".`,
        fix: "Check that this app's crypto client is for its own partition (an app opens its own console-* keys without a grant), and that the console's crypto server is up to date.",
        docs,
      };
    }
    if (/invalid|did not open|tampered|authenticate/i.test(message)) {
      return { status: 'ok', message: `consoleCommands can open commands with "${key}".` };
    }
    return {
      status: 'error',
      message: `consoleCommands could not reach its crypto cipher: ${message}.`,
      fix: 'Check consoleCommands.crypto.cipher (the crypto server URL and token).',
      docs,
    };
  }
}

/** The `console-commands` key of each served partition as the boot log names it (`key <8-char id>`). */
async function commandKeyIds(config: CryptoConfig): Promise<string> {
  const store = runtimeOf()?.store;
  const options = config.topology === 'tenant' ? undefined : config.consoleCommands;
  const own = config.topology === 'control-plane' ? undefined : (config as { app?: string }).app;
  const partitions = options?.partitions ?? (own ? [own] : []);
  const ids = await Promise.all(
    partitions.map(async (partition) => {
      const record = await store?.getKey(partition, CONSOLE_COMMAND_KEY).catch(() => null);
      const version = record
        ? await store?.version(partition, CONSOLE_COMMAND_KEY, record.latestVersion)
        : null;
      const kid = version?.publicKey?.kid;
      return `key ${kid ? kid.slice(0, 8) : '(not created yet)'}`;
    }),
  );
  return ids.join(', ') || 'key (not created yet)';
}
