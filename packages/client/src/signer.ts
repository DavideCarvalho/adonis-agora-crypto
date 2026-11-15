import type { PublicJwk } from '@adonis-agora/crypto-core';
import type { CryptoClient } from './client.js';

export interface CryptoServerSignerOptions {
  /** The crypto server client (URL, partition, token). */
  client: CryptoClient;
  /** The `ed25519` key to sign with. */
  key: string;
}

/**
 * A detached Ed25519 signer whose private key never leaves the crypto server. The signature string
 * is the kit's (`agora:sig1:<kid>:<signature>`), so it verifies with `verify(publicKey, payload,
 * signature)` from the crypto kit — the caller only needs the public JWK.
 *
 * ```ts
 * const signer = cryptoServerSigner({ client, key: 'webhook-signing' })
 * const signature = await signer.sign('{"event":"user.created"}')
 * ```
 */
export interface RemoteSigner {
  readonly key: string;
  /** `agora:sig1:<kid>:<signature>` over the payload (utf8 string or raw bytes). */
  sign(payload: string | Uint8Array): Promise<string>;
  /** Verifies against the server's public key for this key. */
  verify(payload: string | Uint8Array, signature: string): Promise<boolean>;
  /** The current public key (the one new signatures carry). */
  publicKey(): Promise<PublicJwk>;
}

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64url');

export function cryptoServerSigner(options: CryptoServerSignerOptions): RemoteSigner {
  return {
    key: options.key,
    async sign(payload) {
      const bytes = typeof payload === 'string' ? undefined : payload;
      const { signature } = await options.client.sign({
        key: options.key,
        message: bytes ? b64(bytes) : (payload as string),
        ...(bytes ? { encoding: 'base64url' as const } : {}),
      });
      return signature;
    },
    async verify(payload, signature) {
      const bytes = typeof payload === 'string' ? undefined : payload;
      const { valid } = await options.client.verify({
        key: options.key,
        message: bytes ? b64(bytes) : (payload as string),
        signature,
        ...(bytes ? { encoding: 'base64url' as const } : {}),
      });
      return valid;
    },
    async publicKey() {
      const { jwk } = await options.client.publicKey(options.key);
      return jwk;
    },
  };
}
