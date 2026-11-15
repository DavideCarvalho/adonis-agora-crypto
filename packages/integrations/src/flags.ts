import { cryptoFetch } from '@adonis-agora/crypto-core';
import { type CipherSource, cipherFor } from './source.js';

/** The key a flags app uses for its event hop by default. */
export const FLAGS_EVENTS_KEY = 'flags-events';

export interface FlagsEnvelopeOptions {
  source: CipherSource;
  /** Default `flags-events`. */
  key?: string;
  /** Extra context bound into the AAD (e.g. the partition). */
  aad?: string;
  /** How old an envelope may be, in seconds. Default `300`. */
  maxAgeSec?: number;
  /** The underlying fetch (tests, or a tracing/metered wrapper). Default `globalThis.fetch`. */
  fetch?: typeof fetch;
}

/**
 * The envelope `fetch` for flags:
 *
 * ```ts title="config/flags.ts"
 * const envelope = flagsEnvelope({ source: { client: crypto }, aad: 'flags' })
 *
 * transport: transports.http({
 *   url: env.get('FLAGS_URL'),
 *   token,
 *   partition: 'streaming',
 *   ...envelope,                       // { fetch }
 * })
 *
 * sinks: [
 *   sinks.posthog({ apiKey, ...envelope }),
 *   sinks.clickhouse({ url, ...envelope }),
 * ]
 * ```
 *
 * `transports.http` and the posthog/clickhouse sinks take a `fetch`; every batch they send is
 * sealed to the flags server, which opens it with the same key. The tenant ruleset fetch
 * (`remote_source.ts`) does not expose a `fetch` yet — see the integrations docs for that seam.
 */
export function flagsEnvelope(options: FlagsEnvelopeOptions): { fetch: typeof fetch } {
  const key = options.key ?? FLAGS_EVENTS_KEY;
  return {
    fetch: cryptoFetch({
      client: cipherFor(options.source, 'flags:events'),
      key,
      ...(options.aad !== undefined ? { aad: options.aad } : {}),
      ...(options.maxAgeSec !== undefined ? { maxAgeSec: options.maxAgeSec } : {}),
      ...(options.fetch !== undefined ? { fetch: options.fetch } : {}),
    }),
  };
}

/** Just the `fetch`, for `transports.http({ ..., fetch })`. */
export function flagsEnvelopeFetch(options: FlagsEnvelopeOptions): typeof fetch {
  return flagsEnvelope(options).fetch;
}
