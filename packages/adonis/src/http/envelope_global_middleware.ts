import {
  CryptoEnvelopeError,
  cryptoEnvelope,
  ENVELOPE_FIELD,
  ENVELOPE_HEADER,
  ENVELOPE_VERSION,
} from '@adonis-agora/crypto-core';
import type { HttpContext } from '@adonisjs/core/http';
import type { CryptoRuntime } from '../runtime.js';
import { setEnvelopeState } from './envelope.js';
import {
  ENVELOPE_KEY_HEADER,
  type ResolvedInboundEnvelope,
  readEnvelopeBody,
} from './envelope_global.js';

/** One refusal for every decrypt failure: stale, tampered and wrong-key are indistinguishable. */
const GENERIC = 'crypto: the request envelope could not be opened';

interface MutableRequest {
  updateBody?: (body: unknown) => void;
  request?: { headers?: Record<string, unknown> };
  header(name: string): string | undefined;
  body?: () => unknown;
  raw?: () => string | null;
}

type EnvelopeContext = HttpContext & {
  request: MutableRequest;
  containerResolver: { make(binding: string): Promise<CryptoRuntime> };
};

/**
 * Opens a request envelope **before the route reads the body**, registered by the provider on the
 * server stack (`server.use`) — no kernel edit. The plaintext becomes the request body, so
 * `request.body()`, `request.all()` and `request.validateUsing()` behave as if nothing was encrypted.
 *
 * The inbound half only exists when `config/crypto.ts` configures `envelope`; without it the
 * middleware is not registered at all. A request that carries no envelope passes through untouched
 * unless `envelope.required` is set. The opened state goes on the shared request context
 * (`ctx.agora.envelope`), next to what the other Agora libs put there.
 */
export default class CryptoEnvelopeInboundMiddleware {
  async handle(ctx: HttpContext, next: () => Promise<void>): Promise<void> {
    const request = ctx.request as unknown as MutableRequest;
    const inbound = await this.#inbound(ctx);
    if (!inbound) return next();

    const header = request.header(ENVELOPE_HEADER);
    if (header === undefined) {
      if (!inbound.required) return next();
      return refuse(ctx, 400, 'malformed', 'crypto: this app only accepts encrypted requests');
    }
    if (header !== ENVELOPE_VERSION) {
      inbound.warn?.('[@adonis-agora/crypto] envelope refused: unknown version');
      return refuse(ctx, 400, 'malformed', GENERIC);
    }
    const key = request.header(ENVELOPE_KEY_HEADER);
    if (key === undefined || key === '' || !inbound.accept.includes(key)) {
      inbound.warn?.(`[@adonis-agora/crypto] envelope refused: key "${key ?? ''}" is not accepted`);
      return refuse(ctx, 400, 'invalid', GENERIC);
    }

    let read: Awaited<ReturnType<typeof readEnvelopeBody>>;
    try {
      read = await readEnvelopeBody(
        ctx as unknown as Parameters<typeof readEnvelopeBody>[0],
        inbound.maxBytes,
      );
    } catch (error) {
      inbound.warn?.(`[@adonis-agora/crypto] envelope refused: ${String(error)}`);
      return refuse(ctx, 400, 'malformed', GENERIC);
    }
    if (read.tooLarge) return refuse(ctx, 413, 'too_large', GENERIC);
    const ciphertext = read.body?.[ENVELOPE_FIELD];
    if (typeof ciphertext !== 'string' || ciphertext === '') {
      inbound.warn?.('[@adonis-agora/crypto] envelope refused: the body has no ciphertext');
      return refuse(ctx, 400, 'malformed', GENERIC);
    }

    const envelope = cryptoEnvelope({
      client: inbound.cipher,
      key,
      maxAgeSec: inbound.maxAgeSec,
      clockSkewSec: inbound.clockSkewSec,
      ...(inbound.aad !== undefined ? { aad: inbound.aad } : {}),
    });
    let payload: unknown;
    try {
      payload = await envelope.open(ciphertext);
    } catch (error) {
      const reason = error instanceof CryptoEnvelopeError ? error.message : String(error);
      inbound.warn?.(`[@adonis-agora/crypto] envelope refused: ${reason}`);
      return refuse(ctx, 400, 'invalid', GENERIC);
    }

    // `updateBody` is what `body()`/`all()`/`validateUsing()` read. Adonis spreads the value, so only
    // an object can be a body; an array or scalar stays available on `ctx.agora.envelope.payload`.
    const body =
      payload !== null && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
    request.updateBody?.(body);
    const incoming = request.request;
    if (incoming?.headers) {
      // This middleware consumed the raw stream; the router-level body parser must not read it again.
      delete incoming.headers['content-length'];
      delete incoming.headers['transfer-encoding'];
    }
    setEnvelopeState(ctx, {
      key,
      issuedAt: Math.floor(Date.now() / 1000),
      payload,
    });
    return next();
  }

  /** This app's inbound config, carried on its runtime (never a module-level singleton). */
  async #inbound(ctx: HttpContext): Promise<ResolvedInboundEnvelope | undefined> {
    const resolver = (ctx as unknown as EnvelopeContext).containerResolver;
    const runtime = await resolver.make('agora.crypto');
    return runtime.envelope;
  }
}

function refuse(
  ctx: HttpContext,
  status: number,
  code: 'invalid' | 'too_large' | 'malformed',
  message: string,
): void {
  ctx.response.status(status).json({ code, error: message });
}
