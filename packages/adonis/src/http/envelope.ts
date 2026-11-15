import {
  CryptoEnvelopeError,
  cryptoEnvelope,
  ENVELOPE_FIELD,
  ENVELOPE_HEADER,
  ENVELOPE_VERSION,
  type EnvelopeCipher,
} from '@adonis-agora/crypto-client';
import type { HttpContext } from '@adonisjs/core/http';
import type { CryptoService } from '../crypto/service.js';

/** What the middleware puts on the context for a request that arrived as an envelope. */
export interface CryptoEnvelopeState {
  key: string;
  /** When the caller sealed it (epoch seconds). */
  issuedAt: number;
  /** The decrypted payload, also handed to `request.updateBody()`. */
  payload: unknown;
}

declare module '@adonisjs/core/http' {
  interface HttpContext {
    cryptoEnvelope?: CryptoEnvelopeState;
  }
}

export interface CryptoEnvelopeMiddlewareOptions {
  /** A tenant's client, when the keys live on another server (`topology: 'tenant'`). */
  client?: EnvelopeCipher;
  /** Or the in-process service, with the app whose keys it uses. */
  service?: CryptoService;
  /** Required with `service`: the app (partition) the middleware decrypts with. */
  partition?: string;
  /** The `aes256-gcm` key both sides use for this hop (e.g. `svc-flags`). */
  key: string;
  /** How old an envelope may be, in seconds. Default `300`. */
  maxAgeSec?: number;
  /** How far in the future an `iat` may be, in seconds. Default `60`. */
  clockSkewSec?: number;
  /** Extra context bound into the AAD; the caller must use the same value. */
  aad?: string | ((ctx: HttpContext) => string | undefined);
  /** Refuse a request that carries no envelope. Default `false` (it passes through untouched). */
  required?: boolean;
  /** Where the middleware records operations in the audit trail. Default `envelope`. */
  actor?: string;
}

export interface CryptoEnvelopeReplyOptions {
  client?: EnvelopeCipher;
  service?: CryptoService;
  partition?: string;
  key: string;
  aad?: string;
  actor?: string;
}

/** The in-process cipher: the service, acting as one app, with the full rights of the server. */
export function serviceCipher(
  service: CryptoService,
  partition: string,
  actor = 'envelope',
): EnvelopeCipher {
  const principal = { partition, capabilities: ['crypto:*'], actor };
  return {
    encrypt: (input) => service.encrypt(principal, input),
    decrypt: (input) => service.decrypt(principal, input),
  };
}

function cipherOf(options: {
  client?: EnvelopeCipher;
  service?: CryptoService;
  partition?: string;
  actor?: string;
}): EnvelopeCipher {
  if (options.client) return options.client;
  if (options.service && options.partition) {
    return serviceCipher(options.service, options.partition, options.actor ?? 'envelope');
  }
  throw new Error(
    'crypto: an envelope needs either `client` or `service` + `partition` to reach the keys',
  );
}

function fail(ctx: HttpContext, status: number, code: string, message: string): void {
  ctx.response.status(status).json({ error: message, code });
}

/**
 * Decrypts an envelope request before the controller runs, so the rest of the app never sees the
 * ciphertext: the payload replaces the JSON body (`request.body()`, `request.all()` and
 * `request.validateUsing()` all read it) and is also available as `ctx.cryptoEnvelope`.
 *
 * ```ts
 * router.post('/internal/hooks', handler).use(
 *   cryptoEnvelopeMiddleware({ service, partition: 'billing', key: 'svc-hooks' }),
 * )
 * ```
 *
 * A request without the envelope header passes through unless `required`. A tampered, stale or
 * foreign envelope is a `400` with a wire code — never a half-decrypted body.
 */
export function cryptoEnvelopeMiddleware(options: CryptoEnvelopeMiddlewareOptions) {
  const cipher = cipherOf(options);
  const envelope = cryptoEnvelope({
    client: cipher,
    key: options.key,
    ...(options.maxAgeSec !== undefined ? { maxAgeSec: options.maxAgeSec } : {}),
    ...(options.clockSkewSec !== undefined ? { clockSkewSec: options.clockSkewSec } : {}),
  });

  return async function cryptoEnvelopeMiddlewareHandler(
    ctx: HttpContext,
    next: () => Promise<void>,
  ): Promise<void> {
    const header = ctx.request.header(ENVELOPE_HEADER);
    if (header === undefined) {
      if (options.required === true) {
        fail(ctx, 400, 'malformed', 'crypto: this endpoint only accepts an encrypted envelope');
        return;
      }
      return next();
    }
    if (header !== ENVELOPE_VERSION) {
      fail(ctx, 400, 'malformed', `crypto: unknown envelope version "${header}"`);
      return;
    }
    let body: Record<string, unknown>;
    try {
      const parsed = ctx.request.body() as unknown;
      body =
        typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
    } catch {
      fail(ctx, 400, 'malformed', 'crypto: the request body is not JSON');
      return;
    }
    const ciphertext = body[ENVELOPE_FIELD];
    if (typeof ciphertext !== 'string' || ciphertext === '') {
      fail(ctx, 400, 'malformed', `crypto: the body has no "${ENVELOPE_FIELD}" field`);
      return;
    }
    const aad = typeof options.aad === 'function' ? options.aad(ctx) : options.aad;
    let payload: unknown;
    try {
      payload = await envelope.open(ciphertext, { ...(aad !== undefined ? { aad } : {}) });
    } catch (error) {
      if (error instanceof CryptoEnvelopeError) {
        fail(ctx, 400, error.code, error.message);
        return;
      }
      fail(ctx, 400, 'invalid', 'crypto: the envelope did not open');
      return;
    }

    const request = ctx.request as unknown as { updateBody?: (body: unknown) => void };
    if (typeof request.updateBody === 'function') {
      // Adonis 7's supported hook: body(), all() and validateUsing() now read the payload.
      request.updateBody(payload);
    }
    ctx.cryptoEnvelope = {
      key: options.key,
      issuedAt: Math.floor(Date.now() / 1000),
      payload,
    };
    return next();
  };
}

/**
 * Sends an encrypted response the caller's {@link cryptoFetch} opens automatically. The response is
 * still JSON (`{ agoraEnvelope: "…" }`), so proxies and compression keep working.
 */
export async function cryptoEnvelopeReply(
  ctx: HttpContext,
  payload: unknown,
  options: CryptoEnvelopeReplyOptions,
): Promise<void> {
  const cipher = cipherOf(options);
  const document = JSON.stringify({
    v: 1,
    iat: Math.floor(Date.now() / 1000),
    ...(options.aad !== undefined ? { aad: options.aad } : {}),
    body: payload,
  });
  const { ciphertext } = await cipher.encrypt({
    key: options.key,
    plaintext: document,
    aad: `agora:envelope:${ENVELOPE_VERSION}:${options.aad ?? ''}`,
  });
  ctx.response
    .header(ENVELOPE_HEADER, ENVELOPE_VERSION)
    .header('cache-control', 'no-store')
    .json({ [ENVELOPE_FIELD]: ciphertext });
}
