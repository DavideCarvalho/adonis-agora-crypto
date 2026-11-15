import type { AgoraDoctorCheck } from '@adonis-agora/crypto';
import type { KmsAdapterLike } from '@adonis-agora/crypto-core';
import { ROOT_KEYS } from './keys.js';
import { type KmsCheckOptions, type KmsIntegrationOptions, kmsDoctorCheck, kmsFor } from './kms.js';

/** authkit-server's root key: its keystore (JWKS private keys) and account secrets. */
export const AUTHKIT_ROOT_KEY = ROOT_KEYS.authkit;
/** The package the check reports under. */
export const AUTHKIT_PACKAGE = '@adonis-agora/authkit-server';

/**
 * The KMS root for authkit-server:
 *
 * ```ts title="config/authkit.ts"
 * crypto: { kms: authkitKms({ source: { client: crypto } }) }
 * ```
 *
 * Every private key authkit keeps (JWKS signing keys, TOTP secrets) is then sealed with a data key
 * wrapped by `authkit-root`, so rotating that key rotates the fleet.
 */
export function authkitKms(
  options: Omit<KmsIntegrationOptions, 'key'> & { key?: string },
): KmsAdapterLike {
  return kmsFor(options.key ?? AUTHKIT_ROOT_KEY, {
    ...options,
    key: options.key ?? AUTHKIT_ROOT_KEY,
  });
}

/** `agora:doctor --lib authkit`: `authkit-root` exists and this process can use it. */
export function authkitKmsCheck(
  options: Omit<KmsCheckOptions, 'lib' | 'packageName' | 'key'> & { key?: string },
): AgoraDoctorCheck {
  return kmsDoctorCheck({
    ...options,
    lib: 'authkit',
    packageName: AUTHKIT_PACKAGE,
    key: options.key ?? AUTHKIT_ROOT_KEY,
    title: 'KMS root for the keystore and account secrets',
  });
}
