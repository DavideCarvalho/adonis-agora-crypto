import type { AgoraDoctorCheck } from '@adonis-agora/crypto';
import type { KmsAdapterLike } from '@adonis-agora/crypto-client';
import { ROOT_KEYS } from './keys.js';
import { type KmsCheckOptions, type KmsIntegrationOptions, kmsDoctorCheck, kmsFor } from './kms.js';

/** config's root: every secret entry (`crypto:secrets`, `vault://` aside) is sealed under it. */
export const CONFIG_ROOT_KEY = ROOT_KEYS.config;
/** The package the check reports under. */
export const CONFIG_PACKAGE = '@adonis-agora/config';

/**
 * The KMS root for `@adonis-agora/config`:
 *
 * ```ts title="config/config.ts"
 * crypto: { kms: configKms({ source: { client: crypto } }) }
 * ```
 *
 * The control plane keeps no secret key material: each secret carries a data key wrapped by
 * `config-root` on the crypto server. Tenants read their scope as usual; the reveal command still
 * opens it, now with a key the control plane does not own.
 */
export function configKms(
  options: Omit<KmsIntegrationOptions, 'key'> & { key?: string },
): KmsAdapterLike {
  const key = options.key ?? CONFIG_ROOT_KEY;
  return kmsFor(key, { ...options, key });
}

/** `agora:doctor --lib config`: `config-root` exists and this process can use it. */
export function configKmsCheck(
  options: Omit<KmsCheckOptions, 'lib' | 'packageName' | 'key'> & { key?: string },
): AgoraDoctorCheck {
  return kmsDoctorCheck({
    ...options,
    lib: 'config',
    packageName: CONFIG_PACKAGE,
    key: options.key ?? CONFIG_ROOT_KEY,
    title: 'KMS root for the secrets',
  });
}
