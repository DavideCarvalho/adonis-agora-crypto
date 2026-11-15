import type { CryptoClient } from './client.js';

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
  /** The crypto server client (URL, partition, token). */
  client: CryptoClient;
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
  return {
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
}
