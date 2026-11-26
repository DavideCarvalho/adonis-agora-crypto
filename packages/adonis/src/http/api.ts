import {
  CRYPTO_RESOURCE,
  CryptoError,
  type CryptoErrorBody,
  type CryptoKeyType,
  statusForErrorCode,
  type Whoami,
} from '@adonis-agora/crypto-core';
import type { HttpContext } from '@adonisjs/core/http';
import { type CryptoPrincipal, CryptoService } from '../crypto/service.js';
import {
  bearerToken,
  requestHeaders,
  type TenantVerifier,
  type VerifiedTenant,
} from '../topology/verify.js';
import { type CryptoRpc, createCryptoRpc } from '../transports/rpc.js';
import { parseAuditRequest, parseListQuery } from './list.js';

interface RouterLike {
  get(
    pattern: string,
    handler: (ctx: HttpContext) => unknown,
  ): { as(name: string): unknown } | unknown;
  post(pattern: string, handler: (ctx: HttpContext) => unknown): unknown;
  patch(pattern: string, handler: (ctx: HttpContext) => unknown): unknown;
  delete(pattern: string, handler: (ctx: HttpContext) => unknown): unknown;
  any?(pattern: string, handler: (ctx: HttpContext) => unknown): unknown;
  route?(pattern: string, methods: string[], handler: (ctx: HttpContext) => unknown): unknown;
}

const OPERATIONS = [
  'encrypt',
  'decrypt',
  'rewrap',
  'datakeys',
  'sign',
  'verify',
  'hmac',
  'has-key',
] as const;
const BATCHES = ['encrypt', 'decrypt', 'sign', 'verify'] as const;

export interface CryptoApiOptions {
  service: CryptoService;
  verifyTenant: TenantVerifier;
  /** Route prefix. Default `/_crypto`. */
  prefix?: string;
  /** Origins allowed to call the API cross-origin. Default: none. */
  corsOrigins?: string[];
  logger?: { warn(message: string): void };
}

function bodyOf(ctx: HttpContext): Record<string, unknown> {
  const request = ctx.request as unknown as { body?: () => unknown };
  const body = typeof request.body === 'function' ? request.body() : {};
  return typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
}

function paramsOf(ctx: HttpContext): Record<string, string> {
  return (ctx.params ?? {}) as Record<string, string>;
}

/**
 * The tenant-facing API, under `/_crypto/v1`:
 *
 * - operations: `encrypt`, `decrypt`, `rewrap`, `datakeys`, `sign`, `verify`, `hmac` (+ batch);
 * - keys: list, read, create, rotate, policy, delete, `public`, `jwks`, `export`;
 * - `audit`, `whoami`.
 *
 * The app (partition) and the capabilities come from the verified token. A header that claims
 * another app is passed to the verifier (which may need it to pick a shared secret) and is never
 * trusted alone. Every operation is audited by the service, refusals included.
 */
export class CryptoApi {
  readonly prefix: string;
  readonly service: CryptoService;
  readonly rpc: CryptoRpc;

  constructor(private readonly options: CryptoApiOptions) {
    this.prefix = (options.prefix ?? '/_crypto').replace(/\/$/, '');
    this.service = options.service;
    // The same envelope the broker drivers carry, so `transports.http` and the rest agree.
    this.rpc = createCryptoRpc({
      service: options.service,
      verifyTenant: options.verifyTenant,
      ...(options.logger ? { logger: options.logger } : {}),
    });
  }

  register(router: RouterLike): void {
    const p = this.prefix;
    const get = (pattern: string, handler: (ctx: HttpContext) => unknown, name?: string) => {
      const route = router.get(pattern, handler) as { as?: (name: string) => unknown } | undefined;
      if (name && typeof route?.as === 'function') route.as(name);
    };
    get(`${p}/v1/whoami`, (ctx) => this.whoami(ctx), 'crypto.api.whoami');
    get(`${p}/v1/keys`, (ctx) => this.listKeys(ctx), 'crypto.api.keys');
    get(`${p}/v1/keys/:name`, (ctx) => this.getKey(ctx), 'crypto.api.key');
    get(`${p}/v1/keys/:name/public`, (ctx) => this.publicKey(ctx), 'crypto.api.key.public');
    get(`${p}/v1/keys/:name/jwks`, (ctx) => this.jwks(ctx), 'crypto.api.key.jwks');
    get(`${p}/v1/keys/:name/export`, (ctx) => this.exportKey(ctx), 'crypto.api.key.export');
    get(`${p}/v1/audit`, (ctx) => this.audit(ctx), 'crypto.api.audit');

    this.#route(router, `${p}/v1/keys`, 'POST', (ctx) => this.createKey(ctx));
    this.#route(router, `${p}/v1/keys/:name`, 'PATCH', (ctx) => this.updateKey(ctx));
    this.#route(router, `${p}/v1/keys/:name`, 'DELETE', (ctx) => this.deleteKey(ctx));
    this.#route(router, `${p}/v1/keys/:name/rotate`, 'POST', (ctx) => this.rotateKey(ctx));
    this.#route(router, `${p}/v1/transport`, 'POST', (ctx) => this.transport(ctx));

    for (const operation of OPERATIONS) {
      this.#route(router, `${p}/v1/${operation}`, 'POST', (ctx) => this.operation(ctx, operation));
    }
    for (const operation of BATCHES) {
      this.#route(router, `${p}/v1/${operation}/batch`, 'POST', (ctx) =>
        this.batch(ctx, operation),
      );
    }

    if (this.options.corsOrigins?.length && router.route) {
      for (const path of [
        'whoami',
        'keys',
        'keys/:name',
        'audit',
        ...OPERATIONS,
        ...BATCHES.map((op) => `${op}/batch`),
      ]) {
        this.#route(router, `${p}/v1/${path}`, 'OPTIONS', (ctx) => this.preflight(ctx));
      }
    }
  }

  #route(
    router: RouterLike,
    pattern: string,
    method: string,
    handler: (ctx: HttpContext) => unknown,
  ): void {
    if (router.route) {
      router.route(pattern, [method], handler);
      return;
    }
    if (router.any) {
      router.any(pattern, handler);
      return;
    }
    // A minimal router (tests) only has per-method helpers.
    const helper = (router as unknown as Record<string, unknown>)[method.toLowerCase()];
    if (typeof helper === 'function')
      (helper as (p: string, h: unknown) => unknown).call(router, pattern, handler);
  }

  #cors(ctx: HttpContext): void {
    const origin = ctx.request.header('origin');
    if (origin && this.options.corsOrigins?.includes(origin)) {
      ctx.response.header('access-control-allow-origin', origin);
      ctx.response.header('vary', 'Origin');
    }
  }

  async preflight(ctx: HttpContext) {
    this.#cors(ctx);
    ctx.response.header('access-control-allow-methods', 'GET, POST, PATCH, DELETE, OPTIONS');
    ctx.response.header(
      'access-control-allow-headers',
      'authorization, x-api-key, x-crypto-app, content-type',
    );
    return ctx.response.status(204).send('');
  }

  #fail(ctx: HttpContext, error: unknown) {
    if (error instanceof CryptoError) {
      const body: CryptoErrorBody = { error: error.message, code: error.code };
      return ctx.response.status(error.status).json(body);
    }
    if (error instanceof Error && error.message.startsWith('crypto:')) {
      return ctx.response.status(400).json({ error: error.message, code: 'invalid' });
    }
    this.options.logger?.warn(`[@adonis-agora/crypto] request failed: ${(error as Error).message}`);
    return ctx.response
      .status(500)
      .json({ error: 'crypto: internal error', code: 'unreadable' } satisfies CryptoErrorBody);
  }

  #principal(verified: VerifiedTenant): CryptoPrincipal {
    return {
      partition: verified.partition,
      capabilities: verified.capabilities,
      actor: verified.actor ?? verified.clientId ?? verified.partition,
      ...(verified.clientId !== undefined ? { clientId: verified.clientId } : {}),
    };
  }

  async #authenticate(ctx: HttpContext): Promise<CryptoPrincipal | null> {
    this.#cors(ctx);
    const claimed = ctx.request.header('x-crypto-app') ?? undefined;
    let verified: VerifiedTenant | null;
    try {
      verified = await this.options.verifyTenant({
        token: bearerToken(ctx),
        app: claimed,
        partition: claimed,
        tenant: claimed,
        headers: requestHeaders(ctx),
      });
    } catch (error) {
      this.options.logger?.warn(
        `[@adonis-agora/crypto] verifyTenant failed: ${(error as Error).message}`,
      );
      ctx.response.status(401).json({ error: 'crypto: unauthorized', code: 'unauthenticated' });
      return null;
    }
    if (!verified) {
      ctx.response.status(401).json({ error: 'crypto: unauthorized', code: 'unauthenticated' });
      return null;
    }
    if (verified.expiresAt !== undefined && verified.expiresAt <= Date.now()) {
      ctx.response.status(401).json({ error: 'crypto: token expired', code: 'unauthenticated' });
      return null;
    }
    return this.#principal(verified);
  }

  /** Runs an authenticated handler with the shared error mapping. */
  async #run(ctx: HttpContext, handler: (principal: CryptoPrincipal) => Promise<unknown>) {
    const principal = await this.#authenticate(ctx);
    if (!principal) return;
    try {
      return await handler(principal);
    } catch (error) {
      return this.#fail(ctx, error);
    }
  }

  /* ------------------------------------------------------------------------------------------ */
  /* Operations                                                                                  */
  /* ------------------------------------------------------------------------------------------ */

  async operation(ctx: HttpContext, operation: (typeof OPERATIONS)[number]) {
    return this.#run(ctx, async (principal) => {
      const body = bodyOf(ctx);
      const service = this.service;
      switch (operation) {
        case 'encrypt':
          return ctx.response.json(await service.encrypt(principal, body as never));
        case 'decrypt':
          return ctx.response.json(await service.decrypt(principal, body as never));
        case 'has-key':
          return ctx.response.json(await service.hasKey(principal, body as never));
        case 'rewrap':
          return ctx.response.json(await service.rewrap(principal, body as never));
        case 'datakeys':
          return ctx.response.json(await service.generateDataKey(principal, body as never));
        case 'sign':
          return ctx.response.json(await service.sign(principal, body as never));
        case 'verify':
          return ctx.response.json(await service.verify(principal, body as never));
        case 'hmac':
          return ctx.response.json(await service.hmac(principal, body as never));
      }
    });
  }

  async batch(ctx: HttpContext, operation: (typeof BATCHES)[number]) {
    return this.#run(ctx, async (principal) => {
      const items = bodyOf(ctx).items;
      const service = this.service;
      switch (operation) {
        case 'encrypt':
          return ctx.response.json(await service.encryptBatch(principal, items));
        case 'decrypt':
          return ctx.response.json(await service.decryptBatch(principal, items));
        case 'sign':
          return ctx.response.json(await service.signBatch(principal, items));
        case 'verify':
          return ctx.response.json(await service.verifyBatch(principal, items));
      }
    });
  }

  /* ------------------------------------------------------------------------------------------ */
  /* Keys and audit                                                                              */
  /* ------------------------------------------------------------------------------------------ */

  /**
   * `POST /v1/transport` — the envelope every non-messaging driver carries, and what the http
   * driver posts. Answers `200` with `{ ok, result | error }`; an invalid message is a `200` with
   * `ok: false` and a wire code, never a body the caller could mistake for a result.
   */
  async transport(ctx: HttpContext) {
    this.#cors(ctx);
    const reply = await this.rpc.handle(bodyOf(ctx));
    ctx.response.header('cache-control', 'no-store');
    return ctx.response.status(200).json(reply);
  }

  async whoami(ctx: HttpContext) {
    return this.#run(ctx, async (principal) => {
      ctx.response.header('cache-control', 'no-store');
      const who: Whoami = { ...this.service.whoami(principal), resource: CRYPTO_RESOURCE };
      return ctx.response.json(who);
    });
  }

  async listKeys(ctx: HttpContext) {
    return this.#run(ctx, async (principal) => {
      const list = parseListQuery(ctx.request.qs() as Record<string, unknown>, {
        sortable: ['name', 'createdAt', 'updatedAt'],
        defaultSort: { field: 'name', direction: 'asc' },
        filterable: [],
        defaultSize: 50,
        maxSize: 200,
      });
      return ctx.response.json(
        await this.service.listKeys(principal, {
          page: list.page,
          size: list.size,
          ...(list.search !== undefined ? { search: list.search } : {}),
          sort: list.sort as {
            field: 'name' | 'createdAt' | 'updatedAt';
            direction: 'asc' | 'desc';
          },
        }),
      );
    });
  }

  async getKey(ctx: HttpContext) {
    return this.#run(ctx, async (principal) => {
      ctx.response.header('cache-control', 'no-store');
      return ctx.response.json(await this.service.getKey(principal, paramsOf(ctx).name ?? ''));
    });
  }

  async createKey(ctx: HttpContext) {
    return this.#run(ctx, async (principal) => {
      const body = bodyOf(ctx);
      const type = body.type as CryptoKeyType;
      const created = await this.service.createKey(principal, {
        name: String(body.name ?? ''),
        type,
        ...(typeof body.description === 'string' ? { description: body.description } : {}),
        ...(typeof body.deletionAllowed === 'boolean'
          ? { deletionAllowed: body.deletionAllowed }
          : {}),
        ...(typeof body.exportable === 'boolean' ? { exportable: body.exportable } : {}),
      });
      return ctx.response.status(201).json(created);
    });
  }

  async rotateKey(ctx: HttpContext) {
    return this.#run(ctx, async (principal) =>
      ctx.response.json(await this.service.rotateKey(principal, paramsOf(ctx).name ?? '')),
    );
  }

  async updateKey(ctx: HttpContext) {
    return this.#run(ctx, async (principal) => {
      const body = bodyOf(ctx);
      return ctx.response.json(
        await this.service.updateKeyPolicy(principal, paramsOf(ctx).name ?? '', {
          ...(body.description === null || typeof body.description === 'string'
            ? { description: body.description as string | null }
            : {}),
          ...(typeof body.minDecryptionVersion === 'number'
            ? { minDecryptionVersion: body.minDecryptionVersion }
            : {}),
          ...(typeof body.deletionAllowed === 'boolean'
            ? { deletionAllowed: body.deletionAllowed }
            : {}),
          ...(typeof body.exportable === 'boolean' ? { exportable: body.exportable } : {}),
        }),
      );
    });
  }

  async deleteKey(ctx: HttpContext) {
    return this.#run(ctx, async (principal) =>
      ctx.response.json(await this.service.deleteKey(principal, paramsOf(ctx).name ?? '')),
    );
  }

  async exportKey(ctx: HttpContext) {
    return this.#run(ctx, async (principal) => {
      const query = ctx.request.qs() as { version?: string };
      const version = query.version === undefined ? undefined : Number(query.version);
      ctx.response.header('cache-control', 'no-store');
      return ctx.response.json(
        await this.service.exportKey(principal, paramsOf(ctx).name ?? '', version),
      );
    });
  }

  async publicKey(ctx: HttpContext) {
    return this.#run(ctx, async (principal) =>
      ctx.response.json(await this.service.publicKey(principal, paramsOf(ctx).name ?? '')),
    );
  }

  async jwks(ctx: HttpContext) {
    return this.#run(ctx, async (principal) =>
      ctx.response.json(await this.service.jwks(principal, paramsOf(ctx).name ?? '')),
    );
  }

  async audit(ctx: HttpContext) {
    return this.#run(ctx, async (principal) => {
      const request = parseAuditRequest(ctx.request.qs() as Record<string, unknown>);
      return ctx.response.json(
        request.cursor
          ? await this.service.auditCursor(principal, request)
          : await this.service.audit(principal, request),
      );
    });
  }
}

/** Shields CSRF exceptions for the tenant API: server-to-server calls carry no cookie. */
export function cryptoCsrfExceptions(url: string, options: { prefix?: string } = {}): boolean {
  const prefix = (options.prefix ?? '/_crypto').replace(/\/$/, '');
  const path = url.split('?')[0] ?? '';
  return path.startsWith(`${prefix}/v1/`);
}

export { statusForErrorCode };
