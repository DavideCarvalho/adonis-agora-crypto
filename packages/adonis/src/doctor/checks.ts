import { createCryptoClient } from '@adonis-agora/crypto-core';
import type { ApplicationService } from '@adonisjs/core/types';
import { openMaterial } from '../crypto/material.js';
import { materialStatus } from '../crypto/reseal.js';
import type { CryptoConfig, TenantTopologyConfig } from '../define_config.js';
import type { CryptoRuntime } from '../runtime.js';
import { getRuntime, hasRuntime } from '../services/accessor.js';
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
      try {
        const who = await client.whoami();
        return {
          status: 'ok',
          message: `${config.tenant.url}: ${who.partition} with ${who.capabilities.join(', ') || 'no capabilities'}.`,
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
          message: `${config.tenant.url} answered nothing: ${failure.message ?? 'unknown error'}.`,
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
];
