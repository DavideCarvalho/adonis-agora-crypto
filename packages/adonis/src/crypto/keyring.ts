import {
  createKeyring,
  type EncrypterLike,
  type Keyring,
  type KmsAdapter,
  type SecretLike,
} from '../crypto-kit/index.js';

/** Domain separation for the key material this package keeps: one APP_KEY never yields it twice. */
export const KEY_MATERIAL_PURPOSE = 'crypto:key-material';

/** One key: a secret, or `{ id, secret }` when you want to name the active one. */
export type CryptoKey = SecretLike | { id: string; secret: SecretLike };

/**
 * The root keyring: what seals the key material this server holds at rest. The default (nothing
 * here) is the app's own encryption service (`config/encryption.ts`), so rotation happens there.
 * `keys` lets this package own the keys instead (newest first; the first seals).
 */
export interface CryptoKeyringConfig {
  /** Keys, newest first: the first seals, every one opens. `{ id, secret }` names the active one. */
  keys?: CryptoKey[];
  /** With `{ id, secret }` keys: the id that seals. */
  active?: string;
  /** The app's `encryption` service, or any Adonis-encryption-shaped one. */
  encryption?: EncrypterLike;
  /** A cloud KMS root: every key material gets a data key wrapped by it (envelope). */
  kms?: KmsAdapter;
}

/**
 * Key material is bound to its place: a sealed private key copied to another app or another
 * version does not open. The AAD never reaches the database.
 */
export function keyMaterialAad(partition: string, name: string, version: number): string {
  return `crypto.key:${partition}/${name}:${version}`;
}

/** Builds the keyring the server seals key material with (`crypto:key-material`). */
export function createCryptoKeyring(
  options: CryptoKeyringConfig & { appKey?: SecretLike | undefined } = {},
): Keyring {
  if (options.keys?.length && options.encryption !== undefined) {
    throw new Error('crypto: give either `crypto.keys` or `crypto.encryption`, not both');
  }
  if (options.keys?.length) {
    const configured = options.keys.map((key, index) => {
      const named =
        typeof key === 'object' && key !== null && 'secret' in key
          ? (key as { id: string; secret: SecretLike })
          : { id: `key-${index}`, secret: key as SecretLike };
      return named;
    });
    const activeId = options.active ?? configured[0]?.id;
    const active = configured.find((key) => key.id === activeId);
    if (!active) throw new Error(`crypto: active key "${activeId}" is not in crypto.keys`);
    const ordered = [active, ...configured.filter((key) => key !== active)];
    return createKeyring({
      purpose: KEY_MATERIAL_PURPOSE,
      keys: ordered.map((key) => key.secret),
      ...(options.kms !== undefined ? { kms: options.kms } : {}),
    });
  }
  if (options.encryption !== undefined) {
    if (options.active !== undefined) {
      throw new Error('crypto: `active` only applies with `crypto.keys`');
    }
    return createKeyring({
      purpose: KEY_MATERIAL_PURPOSE,
      encryption: options.encryption,
      ...(options.kms !== undefined ? { kms: options.kms } : {}),
    });
  }
  if (options.appKey === undefined || options.appKey === '') {
    throw new Error('crypto: no keyring: pass `crypto.keys`, `crypto.encryption`, or set APP_KEY');
  }
  return createKeyring({
    purpose: KEY_MATERIAL_PURPOSE,
    keys: [options.appKey],
    ...(options.kms !== undefined ? { kms: options.kms } : {}),
  });
}

export type { EncrypterLike, Keyring, KmsAdapter, SecretLike };

/** Backwards-compatible alias for the options shape. */
export type KeyringOptions = CryptoKeyringConfig;
