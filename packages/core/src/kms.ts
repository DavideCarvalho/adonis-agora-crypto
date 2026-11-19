import type { CryptoClient } from './client.js';
import type { EnvelopeCipher } from './envelope.js';

/**
 * The crypto kit's `KmsAdapter`, declared structurally so this package never imports
 * `@adonisjs/core`: an `@adonis-agora/config`, authkit or agent keyring accepts it unchanged.
 */
export interface KmsContextLike {
  purpose: string;
}

export interface KmsAdapterLike {
  wrap(dataKey: Uint8Array, context: KmsContextLike): Promise<Uint8Array>;
  unwrap(wrapped: Uint8Array, context: KmsContextLike): Promise<Uint8Array>;
}

export interface CryptoServerKmsOptions {
  /**
   * The crypto server client (URL, partition, token), or anything with the same `encrypt`/`decrypt`
   * shape — e.g. the in-process service cipher when the server is embedded in this app.
   */
  client: CryptoClient | EnvelopeCipher;
  /** The `aes256-gcm` key the data keys are wrapped with. */
  key: string;
  /**
   * Bind every wrapped key to its keyring purpose (the kit's `context.purpose`), so a data key
   * wrapped for `config:secrets` cannot be unwrapped for another purpose. Default `true`.
   */
  bindPurpose?: boolean;
}

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64url');

/**
 * The crypto server as the KMS root of any Agora lib's crypto kit:
 *
 * ```ts
 * const keyring = createKeyring({
 *   purpose: 'config:secrets',
 *   encryption: appEncryption,
 *   kms: cryptoServerKms({ client, key: 'config-root' }),
 * })
 * ```
 *
 * Every sealed value then carries a data key wrapped by the crypto server, and only the server's
 * key opens it — rotating that key (`crypto:keys:rotate config-root`) rotates the whole fleet,
 * with no key material in the app at all.
 */
export function cryptoServerKms(options: CryptoServerKmsOptions): KmsAdapterLike {
  const bindPurpose = options.bindPurpose ?? true;
  const aadOf = (context: KmsContextLike) => (bindPurpose ? `kms:${context.purpose}` : 'kms');
  const adapter: KmsAdapterLike = {
    async wrap(dataKey, context) {
      const { ciphertext } = await options.client.encrypt({
        key: options.key,
        plaintext: b64(dataKey),
        aad: aadOf(context),
      });
      return Buffer.from(ciphertext, 'utf8');
    },
    async unwrap(wrapped, context) {
      const { plaintext } = await options.client.decrypt({
        key: options.key,
        ciphertext: Buffer.from(wrapped).toString('utf8'),
        aad: aadOf(context),
      });
      return Buffer.from(plaintext, 'base64url');
    },
  };
  // Telescope's Architecture page (`config: root key → kms agora-crypto`): the lib using this
  // adapter carries it in its config. The key name is not a secret; the client's URL stays out.
  try {
    Object.defineProperty(adapter, Symbol.for('@adonis-agora/stack'), {
      value: [{ tech: 'kms', label: 'agora-crypto', purpose: 'root key' }],
      enumerable: false,
      configurable: true,
    });
  } catch {
    // nothing to describe
  }
  return adapter;
}
