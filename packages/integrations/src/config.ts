import type { AgoraDoctorCheck } from '@adonis-agora/crypto';
import type { KmsAdapterLike } from '@adonis-agora/crypto-client';
import { ROOT_KEYS } from './keys.js';
import { type KmsCheckOptions, type KmsIntegrationOptions, kmsDoctorCheck, kmsFor } from './kms.js';
import { cipherFor } from './source.js';

/** config's root: every secret entry (`crypto:secrets`, `vault://` aside) is sealed under it. */
export const CONFIG_ROOT_KEY = ROOT_KEYS.config;
/** The package the check reports under. */
export const CONFIG_PACKAGE = '@adonis-agora/config';

/**
 * The recipient-held open event, re-exported here because it is config that emits it:
 * `config:sealed.open` in the product's bus, carrying `actor ?? sub`, the key and the `kid`.
 */
export {
  SEALED_OPEN_EVENT,
  type SealedOpenActor,
  type SealedOpenEvent,
  type SealedOpenEventInput,
  sealedOpenChannel,
  sealedOpenEvent,
} from './audit.js';

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

/* ---------------------------------------------------------------------------------------------- */
/* Secrets stored in config, decrypted by the app (server-held)                                    */
/* ---------------------------------------------------------------------------------------------- */

/**
 * A secret entry as config stores it: no plaintext, just the crypto key's name and the ciphertext.
 * The control plane can write it (it holds `crypto:encrypt:<key>`) and can never read it (it does
 * not hold `crypto:decrypt:<key>`); the app reads it with its own token.
 */
export interface CryptoReference {
  /** The crypto server key the value was sealed with (`config-root` by default). */
  key: string;
  /** `agora:ct1:…` (or `agora:pk1:…` for an x25519 key). Opaque to config. */
  ciphertext: string;
}

/** What the reference is bound to: the entry's identity inside config. */
export interface ConfigEntryRef {
  app: string;
  environment: string;
  /** Default `main`. */
  label?: string;
  /** The entry's dot path. */
  key: string;
}

/**
 * The AAD both sides derive for one entry: a reference copied to another app, environment, label or
 * key does not open. `configCrypto` uses it for every seal/open unless the caller passes another.
 */
export function configCryptoAad(entry: ConfigEntryRef): string {
  return `config:${entry.app}:${entry.environment}:${entry.label ?? 'main'}:${entry.key}`;
}

export interface ConfigCryptoOptions {
  source: KmsIntegrationOptions['source'];
  /** The key new references seal with. Default `config-root`. */
  key?: string;
  /**
   * Keys a reference may name when opening. Default `[key]`: a tampered config cannot point the app
   * at another key its token happens to hold (`fleet-root`, …). List the old roots during a rotation.
   */
  keys?: string[];
}

export interface ConfigCrypto {
  /** Seals a plaintext for storage. Needs `crypto:encrypt:<key>` on the source's token. */
  seal(
    plaintext: string,
    entry: ConfigEntryRef,
    options?: { key?: string; aad?: string },
  ): Promise<CryptoReference>;
  /** Opens a stored reference. Needs `crypto:decrypt:<key>` on the source's token. */
  open(
    reference: CryptoReference,
    entry: ConfigEntryRef,
    options?: { aad?: string },
  ): Promise<string>;
  /** Whether a value already looks like a reference (so the control plane can mask it). */
  isReference(value: unknown): value is CryptoReference;
  /** Validates a reference from config before opening it (allow-list, shape, ciphertext prefix). */
  parseReference(value: unknown): CryptoReference;
}

/**
 * The *server-held* config secret seam: config stores `{ key, ciphertext }`, the app decrypts it at
 * boot/reload with its own token.
 *
 * ```ts title="config/config.ts (control plane: encrypt only)"
 * const secrets = configCrypto({ source: { client: crypto }, key: 'config-root' })
 * const stored = await secrets.seal('hunter2', { app: 'streaming', environment: 'production', key: 'db.password' })
 * // entry value: { key: 'config-root', ciphertext: 'agora:ct1:config-root:1:…' }
 * ```
 *
 * ```ts title="the app (decrypt only)"
 * const secrets = configCrypto({ source: { client: crypto } })
 * const password = await secrets.open(entry.value, { app, environment, key })
 * ```
 *
 * The crypto server's partition is the same on both sides (recommended: a dedicated `platform`
 * partition, or the control plane's own): the control plane's token holds
 * `crypto:encrypt:config-root` only, the app's holds `crypto:decrypt:config-root` only.
 */
/** Structural check for a stored reference: `{ key, ciphertext }` and nothing else. */
export function isCryptoReference(value: unknown): value is CryptoReference {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.key === 'string' &&
    typeof candidate.ciphertext === 'string' &&
    Object.keys(candidate).every((field) => field === 'key' || field === 'ciphertext')
  );
}

export function configCrypto(options: ConfigCryptoOptions): ConfigCrypto {
  const sealKey = options.key ?? CONFIG_ROOT_KEY;
  const allowed = new Set(options.keys ?? [sealKey]);
  const cipher = cipherFor(options.source, 'config:secrets');

  return {
    isReference: isCryptoReference,

    parseReference(value) {
      if (!this.isReference(value)) {
        throw new Error(
          'crypto: a crypto reference is { key, ciphertext } and nothing else (no plaintext)',
        );
      }
      if (value.key === '' || value.ciphertext === '') {
        throw new Error('crypto: a crypto reference needs a key name and a ciphertext');
      }
      if (!allowed.has(value.key)) {
        throw new Error(
          `crypto: the reference names "${value.key}", which this app is not configured to open (allowed: ${[...allowed].join(', ')})`,
        );
      }
      if (!value.ciphertext.startsWith('agora:')) {
        throw new Error('crypto: the reference ciphertext is not an agora: value');
      }
      return { key: value.key, ciphertext: value.ciphertext };
    },

    async seal(plaintext, entry, sealOptions = {}) {
      if (typeof plaintext !== 'string') throw new Error('crypto: seal takes a string');
      const key = sealOptions.key ?? sealKey;
      const aad = sealOptions.aad ?? configCryptoAad(entry);
      const { ciphertext } = await cipher.encrypt({ key, plaintext, aad, context: aad });
      return { key, ciphertext };
    },

    async open(reference, entry, openOptions = {}) {
      const parsed = this.parseReference(reference);
      const aad = openOptions.aad ?? configCryptoAad(entry);
      const { plaintext } = await cipher.decrypt({
        key: parsed.key,
        ciphertext: parsed.ciphertext,
        aad,
        // The entry path, in clear, so the crypto audit says which secret was opened.
        context: aad,
      });
      return plaintext;
    },
  };
}
