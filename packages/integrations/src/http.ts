/**
 * The generic HTTP seam: an envelope `fetch` for any service-to-service call, the receiver
 * middleware, and the encrypted reply.
 *
 * - `authkitTenantToken({ issuer, clientId, clientSecret, resource, ...envelope })` — the token
 *   request to authkit is encrypted too;
 * - `createConfigClient({ url, partition, token, ...envelope })` — the tenant's config fetch;
 * - `createFlagsClient({ url, fetch: envelope.fetch })` (or `flagsEnvelope` from `/flags`).
 */

export {
  type CryptoEnvelopeMiddlewareOptions,
  type CryptoEnvelopeReplyOptions,
  type CryptoEnvelopeState,
  cryptoEnvelopeMiddleware,
  cryptoEnvelopeReply,
  serviceCipher,
} from '@adonis-agora/crypto';
export {
  CryptoEnvelopeError,
  type CryptoEnvelopeErrorCode,
  type CryptoEnvelopeOptions,
  cryptoEnvelope,
  cryptoFetch,
  ENVELOPE_FIELD,
  ENVELOPE_HEADER,
  ENVELOPE_VERSION,
  type EnvelopeCipher,
} from '@adonis-agora/crypto-core';
export { type CipherSource, cipherFor } from './source.js';

import { cryptoFetch } from '@adonis-agora/crypto-core';
import { type CipherSource, cipherFor } from './source.js';

export interface HttpEnvelopeOptions {
  source: CipherSource;
  /** The key both sides use for this hop (e.g. `svc-flags`). */
  key: string;
  /** Extra context bound into the AAD. */
  aad?: string;
  /** How old an envelope may be, in seconds. Default `300`. */
  maxAgeSec?: number;
  /** The underlying fetch (tests, or a tracing/metered wrapper). Default `globalThis.fetch`. */
  fetch?: typeof fetch;
}

/**
 * `{ fetch }`, spreadable into any client that takes one:
 *
 * ```ts
 * const envelope = httpEnvelope({ source: { client: crypto }, key: 'svc-config' })
 * const token = authkitTenantToken({ issuer, clientId, clientSecret, resource, ...envelope })
 * const config = createConfigClient({ url, partition: 'streaming', token, ...envelope })
 * ```
 */
export function httpEnvelope(options: HttpEnvelopeOptions): { fetch: typeof fetch } {
  return {
    fetch: cryptoFetch({
      client: cipherFor(options.source, 'http:envelope'),
      key: options.key,
      ...(options.aad !== undefined ? { aad: options.aad } : {}),
      ...(options.maxAgeSec !== undefined ? { maxAgeSec: options.maxAgeSec } : {}),
      ...(options.fetch !== undefined ? { fetch: options.fetch } : {}),
    }),
  };
}
