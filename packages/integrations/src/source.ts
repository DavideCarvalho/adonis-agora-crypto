import type { CryptoService } from '@adonis-agora/crypto';
import { serviceCipher } from '@adonis-agora/crypto';
import type { CryptoClient, EnvelopeCipher } from '@adonis-agora/crypto-core';

/**
 * Where the keys live. Both work with every integration:
 *
 * - `{ client }` — a remote crypto server (`topology: 'tenant'`), or one reached over HTTP from an
 *   app that is not the server;
 * - `{ service, partition }` — the crypto server embedded in this app (`standalone` /
 *   `control-plane`): the calls run in process, no HTTP hop, same audit.
 */
export type CipherSource =
  | { client: CryptoClient }
  | { service: CryptoService; partition: string; actor?: string };

/** The two calls every integration needs (`encrypt` / `decrypt` on one key). */
export type Cipher = EnvelopeCipher;

/** Normalizes both sources into the cipher the integrations use. */
export function cipherFor(source: CipherSource, actor = 'integration'): Cipher {
  if ('client' in source) return source.client;
  return serviceCipher(source.service, source.partition, source.actor ?? actor);
}

/** The library name a source belongs to, for error messages. */
export function describeSource(source: CipherSource): string {
  return 'client' in source
    ? 'remote crypto server'
    : `embedded crypto server (${source.partition})`;
}
