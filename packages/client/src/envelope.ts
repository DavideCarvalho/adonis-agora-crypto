import type { CryptoClient } from './client.js';

/** The header that marks a request or a response as an envelope. Never carries the payload. */
export const ENVELOPE_HEADER = 'x-crypto-envelope';
/** The body field holding the ciphertext, so an ordinary JSON body parser sees a normal object. */
export const ENVELOPE_FIELD = 'agoraEnvelope';
/** Bumped when the plaintext shape or the AAD change. */
export const ENVELOPE_VERSION = 'v1';

export type CryptoEnvelopeErrorCode = 'malformed' | 'stale' | 'invalid';

/** A request/response that is not a valid envelope (tampered, stale, from another key or context). */
export class CryptoEnvelopeError extends Error {
  constructor(
    readonly code: CryptoEnvelopeErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'CryptoEnvelopeError';
  }
}

/** What an envelope needs from a crypto server: the two calls, nothing else. */
export interface EnvelopeCipher {
  encrypt(input: { key: string; plaintext: string; aad?: string }): Promise<{ ciphertext: string }>;
  decrypt(input: { key: string; ciphertext: string; aad?: string }): Promise<{ plaintext: string }>;
}

export interface CryptoEnvelopeOptions {
  /**
   * The crypto server client (URL, partition, token). On a server, a small object over the
   * in-process service fits the same shape (see the middleware in `@adonis-agora/crypto`).
   */
  client: CryptoClient | EnvelopeCipher;
  /** The `aes256-gcm` key both sides use for this hop (e.g. `svc-flags`). */
  key: string;
  /** How old an envelope may be, in seconds. Default `300`. */
  maxAgeSec?: number;
  /** How far in the future an `iat` may be, in seconds. Default `60`. */
  clockSkewSec?: number;
  /**
   * Extra context bound into the AAD (a tenant, a route prefix, a direction). The receiver must be
   * configured with the same value, so an envelope captured from one context cannot be replayed in
   * another.
   */
  aad?: string;
  /** Clock, for tests. */
  now?: () => number;
}

/** What travels in the ciphertext: a small, versioned JSON document. */
interface EnvelopePayload {
  v: number;
  iat: number;
  aad?: string;
  body?: unknown;
}

const envelopeAad = (aad: string | undefined) => `agora:envelope:${ENVELOPE_VERSION}:${aad ?? ''}`;

/**
 * Encrypted request/response envelopes for service-to-service HTTP, keyed by the crypto server.
 *
 * ```ts
 * const envelope = cryptoEnvelope({ client, key: 'svc-flags' })
 * const ciphertext = await envelope.seal({ rule: 'checkout', enabled: true })
 * const payload = await envelope.open(ciphertext)
 * ```
 *
 * The plaintext never appears in the request; only the holder of the key (the crypto server, plus
 * every app whose token holds `crypto:encrypt:<key>` / `crypto:decrypt:<key>`) can produce or read
 * one. Freshness comes from `iat` (a stale envelope is refused), integrity from AES-GCM, and the
 * AAD binds the configured context. Authenticity of the *caller* is still the token: an envelope
 * protects what is said, not who said it.
 */
export function cryptoEnvelope(options: CryptoEnvelopeOptions) {
  const now = options.now ?? Date.now;
  const maxAgeSec = options.maxAgeSec ?? 300;
  const clockSkewSec = options.clockSkewSec ?? 60;

  return {
    /** Seals a JSON payload into the string that goes into the request body. */
    async seal(payload: unknown, extra: { aad?: string } = {}): Promise<string> {
      const aad = extra.aad ?? options.aad;
      const document: EnvelopePayload = {
        v: 1,
        iat: Math.floor(now() / 1000),
        ...(aad !== undefined ? { aad } : {}),
        body: payload,
      };
      const { ciphertext } = await options.client.encrypt({
        key: options.key,
        plaintext: JSON.stringify(document),
        aad: envelopeAad(aad),
      });
      return ciphertext;
    },

    /** Opens an envelope, refusing one that is stale, tampered with or from another context. */
    async open<T = unknown>(ciphertext: string, extra: { aad?: string } = {}): Promise<T> {
      if (typeof ciphertext !== 'string' || ciphertext === '') {
        throw new CryptoEnvelopeError('malformed', 'crypto: the envelope is empty');
      }
      const aad = extra.aad ?? options.aad;
      let plaintext: string;
      try {
        const { plaintext: opened } = await options.client.decrypt({
          key: options.key,
          ciphertext,
          aad: envelopeAad(aad),
        });
        plaintext = opened;
      } catch (error) {
        throw new CryptoEnvelopeError(
          'invalid',
          `crypto: the envelope did not open (${(error as Error).message})`,
        );
      }
      let document: EnvelopePayload;
      try {
        document = JSON.parse(plaintext) as EnvelopePayload;
      } catch {
        throw new CryptoEnvelopeError('malformed', 'crypto: the envelope is not JSON');
      }
      if (document.v !== 1) {
        throw new CryptoEnvelopeError(
          'malformed',
          `crypto: unknown envelope version ${document.v}`,
        );
      }
      if (typeof document.iat !== 'number') {
        throw new CryptoEnvelopeError('malformed', 'crypto: the envelope has no issued-at');
      }
      const seconds = now() / 1000;
      if (seconds - document.iat > maxAgeSec) {
        throw new CryptoEnvelopeError('stale', `crypto: the envelope is older than ${maxAgeSec}s`);
      }
      if (document.iat - seconds > clockSkewSec) {
        throw new CryptoEnvelopeError('stale', 'crypto: the envelope was issued in the future');
      }
      if ((document.aad ?? undefined) !== (aad ?? undefined)) {
        throw new CryptoEnvelopeError('invalid', 'crypto: the envelope belongs to another context');
      }
      return document.body as T;
    },
  };
}

const isJsonBody = (body: unknown): body is string | object => {
  if (typeof body === 'string') return true;
  if (typeof body !== 'object' || body === null) return false;
  // Anything the platform treats as a binary/stream payload stays untouched.
  if (body instanceof Uint8Array || body instanceof ArrayBuffer) return false;
  if (typeof FormData !== 'undefined' && body instanceof FormData) return false;
  if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) return false;
  if (typeof Blob !== 'undefined' && body instanceof Blob) return false;
  if (typeof (body as { pipe?: unknown }).pipe === 'function') return false;
  if (typeof (body as { getReader?: unknown }).getReader === 'function') return false;
  return true;
};

function jsonValue(body: string | object): unknown {
  if (typeof body !== 'string') return body;
  try {
    return JSON.parse(body);
  } catch {
    return body;
  }
}

/**
 * A `fetch` that seals the request body and opens an encrypted response. Drop it into any client
 * that takes a `fetch` option, so a call to another service is encrypted by configuration only:
 *
 * ```ts
 * const fetch = cryptoFetch({ client, key: 'svc-flags' })
 * const flags = createFlagsClient({ url, fetch })      // the wire payload is encrypted
 * ```
 *
 * A body that is not JSON (a stream, `FormData`, bytes) is sent untouched; a response without the
 * envelope header is returned as-is.
 */
export function cryptoFetch(
  options: CryptoEnvelopeOptions & { fetch?: typeof fetch },
): typeof fetch {
  const inner = options.fetch ?? fetch;
  const envelope = cryptoEnvelope(options);

  return async function cryptoFetchImpl(input, init) {
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers = new Headers(init?.headers);
    const body = init?.body;
    let outgoing = init;

    if (
      body !== undefined &&
      body !== null &&
      method !== 'GET' &&
      method !== 'HEAD' &&
      isJsonBody(body)
    ) {
      const ciphertext = await envelope.seal(jsonValue(body));
      headers.set('content-type', 'application/json');
      headers.set(ENVELOPE_HEADER, ENVELOPE_VERSION);
      headers.set('x-crypto-key', options.key);
      headers.delete('content-length');
      outgoing = { ...init, headers, body: JSON.stringify({ [ENVELOPE_FIELD]: ciphertext }) };
    }

    const response = await inner(input, outgoing);
    if (response.headers.get(ENVELOPE_HEADER) !== ENVELOPE_VERSION) return response;
    const text = await response.text();
    let field: unknown;
    try {
      field = (JSON.parse(text) as Record<string, unknown>)[ENVELOPE_FIELD];
    } catch {
      throw new CryptoEnvelopeError('malformed', 'crypto: the response is not an envelope body');
    }
    if (typeof field !== 'string') {
      throw new CryptoEnvelopeError('malformed', `crypto: the response has no "${ENVELOPE_FIELD}"`);
    }
    const payload = await envelope.open(field);
    const responseHeaders = new Headers(response.headers);
    responseHeaders.delete(ENVELOPE_HEADER);
    responseHeaders.set('content-type', 'application/json');
    return new Response(JSON.stringify(payload), {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
    });
  };
}
