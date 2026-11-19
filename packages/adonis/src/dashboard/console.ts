import { readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import {
  CryptoError,
  type CryptoKeyType,
  type CryptoKeyView,
  type OffsetPage,
} from '@adonis-agora/crypto-core';
import { InvalidColumnFilterError } from '@adonis-agora/filter';
import type { HttpContext } from '@adonisjs/core/http';
import type { CryptoPrincipal, CryptoService } from '../crypto/service.js';
import {
  type CommandMeta,
  FederatedAppError,
  type FederatedCryptoApp,
  type FederatedCryptoApps,
  testKey,
} from '../federation/console.js';
import { parseAuditRequest, parseListQuery } from '../http/list.js';
import { resolveAccessDeniedPage } from './access_denied_page.js';
import { type ConsoleActor, consoleActor } from './actor.js';
import {
  type ConsoleAuthorizeDecision,
  consoleAppAllowed,
  consoleVisibleApps,
  resolveConsoleAuthorize,
} from './console_authorize.js';
import { resolveSignOut, resolveViewer } from './console_shell.js';
import {
  type AgoraConsoleRegistry,
  cryptoConsoleSearch,
  listVisibleConsoles,
  otherConsoles,
  searchConsoles,
} from './console_switcher.js';
import type { ResolvedConsoleConfig } from './define_config.js';
import { contentTypeFor, renderIndexHtml } from './spa.js';

interface RouterLike {
  get(pattern: string, handler: (ctx: HttpContext) => unknown): unknown;
  post(pattern: string, handler: (ctx: HttpContext) => unknown): unknown;
  patch(pattern: string, handler: (ctx: HttpContext) => unknown): unknown;
  delete(pattern: string, handler: (ctx: HttpContext) => unknown): unknown;
}

export interface CryptoConsoleOptions {
  service: CryptoService;
  config: ResolvedConsoleConfig;
  /** The built SPA (`dist/assets/spa`), passed by the provider so this file stays path-free. */
  spaDir: string;
  /** The app used as the picker's default (standalone). */
  defaultPartition?: string;
  /** `app.inProduction`, for the default gate (open outside production, deny inside). */
  inProduction: boolean;
  topology: 'standalone' | 'control-plane';
  registry?: AgoraConsoleRegistry;
  logger: { warn(message: string): void; info?(message: string): void };
  /** Other apps this console shows (`console.federatedApps`): read from their stores, operated through them. */
  federated?: FederatedCryptoApps;
}

/** This console's id in the `'agora.consoles'` registry. */
export const CONSOLE_ID = 'crypto';

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * The crypto console: the SPA plus its JSON API, under `console.path` (default `/_crypto`).
 *
 * It never reveals key material or plaintext: keys are metadata and versions, the audit is who did
 * what, and there is no export button. Every action goes through {@link CryptoService}, so the
 * console gets the same validation, policy enforcement and audit as the API and the commands.
 */
export class CryptoConsole {
  readonly #authorize: (ctx: HttpContext) => Promise<ConsoleAuthorizeDecision>;
  /** The `apps` grant of each request that passed the guard. */
  readonly #grants = new WeakMap<HttpContext, '*' | string[] | undefined>();
  /** The `capabilities` of each request that passed the guard, when the authorizer said. */
  readonly #capabilities = new WeakMap<HttpContext, string[]>();
  #warned = false;

  constructor(private readonly options: CryptoConsoleOptions) {
    this.#authorize = options.config.authorize
      ? resolveConsoleAuthorize(options.config.authorize)
      : async (_ctx) => {
          if (!this.options.inProduction) return { allowed: true };
          if (!this.#warned) {
            this.#warned = true;
            this.options.logger.warn(
              '[@adonis-agora/crypto] the console has no `authorize`: it is open outside production and denies every request in production',
            );
          }
          return { allowed: false, status: 403, reason: 'forbidden' };
        };
  }

  get path(): string {
    return this.options.config.path;
  }

  get api(): string {
    return this.options.config.api;
  }

  get service(): CryptoService {
    return this.options.service;
  }

  get config(): ResolvedConsoleConfig {
    return this.options.config;
  }

  register(router: RouterLike): void {
    const root = this.options.config.path === '' ? '' : this.options.config.path;
    const api = this.options.config.api;

    // One route only: AdonisJS normalizes the trailing slash, so `/path` and `/path/` are the same
    // route and registering both is a "Duplicate route found" at boot.
    router.get(root === '' ? '/' : root, (ctx) => this.spa(ctx));
    router.get(`${root}/assets/:file`, (ctx) => this.asset(ctx));

    router.get(`${api}/meta`, (ctx) => this.#guarded(ctx, () => this.meta(ctx)));
    router.get(`${api}/apps`, (ctx) => this.#guarded(ctx, () => this.apps(ctx)));
    router.get(`${api}/overview`, (ctx) => this.#guarded(ctx, () => this.overview(ctx)));
    router.get(`${api}/keys`, (ctx) => this.#guarded(ctx, () => this.listKeys(ctx)));
    router.post(`${api}/keys`, (ctx) => this.#guarded(ctx, () => this.createKey(ctx)));
    router.get(`${api}/keys/:name`, (ctx) => this.#guarded(ctx, () => this.getKey(ctx)));
    router.patch(`${api}/keys/:name`, (ctx) => this.#guarded(ctx, () => this.updateKey(ctx)));
    router.delete(`${api}/keys/:name`, (ctx) => this.#guarded(ctx, () => this.deleteKey(ctx)));
    router.post(`${api}/keys/:name/rotate`, (ctx) => this.#guarded(ctx, () => this.rotateKey(ctx)));
    router.post(`${api}/keys/:name/test`, (ctx) => this.#guarded(ctx, () => this.testKey(ctx)));
    router.post(`${api}/keys/:name/rewrap`, (ctx) => this.#guarded(ctx, () => this.rewrap(ctx)));
    router.get(`${api}/audit`, (ctx) => this.#guarded(ctx, () => this.audit(ctx)));
    router.get(`${api}/consoles`, (ctx) => this.#guarded(ctx, () => this.consoles(ctx)));
    router.get(`${api}/consoles/search`, (ctx) => this.#guarded(ctx, () => this.search(ctx)));
  }

  async #guard(ctx: HttpContext, kind: 'api' | 'page'): Promise<boolean> {
    const decision = await this.#authorize(ctx);
    if (decision.allowed) {
      this.#grants.set(ctx, decision.apps);
      if (Array.isArray(decision.capabilities)) {
        this.#capabilities.set(ctx, decision.capabilities);
      }
      return true;
    }
    if (decision.status === 302) {
      ctx.response.redirect(decision.redirectTo);
      return false;
    }
    if (kind === 'api') {
      ctx.response.status(decision.status).json({ error: decision.reason });
      return false;
    }
    const html = await resolveAccessDeniedPage(
      {
        status: decision.status,
        reason: decision.reason,
        basePath: this.options.config.path,
        ...(this.options.config.loginHref ? { loginHref: this.options.config.loginHref } : {}),
      },
      this.options.config.accessDenied,
      ctx,
      () => false,
    );
    if (html !== null) {
      ctx.response
        .status(decision.status)
        .header('content-type', 'text/html; charset=utf-8')
        .header('cache-control', 'no-store')
        .send(html);
    }
    return false;
  }

  async #guarded(ctx: HttpContext, handler: () => Promise<unknown>): Promise<unknown> {
    if (!(await this.#guard(ctx, 'api'))) return;
    try {
      return await handler();
    } catch (error) {
      return this.#fail(ctx, error);
    }
  }

  #fail(ctx: HttpContext, error: unknown) {
    if (error instanceof HttpError) {
      return ctx.response.status(error.status).json({ error: error.message });
    }
    if (error instanceof FederatedAppError) {
      if (error.detail !== undefined) {
        this.options.logger.warn(
          `[@adonis-agora/crypto] federated console: ${error.message}: ${error.detail}`,
        );
      }
      return ctx.response.status(error.status).json({ error: error.message });
    }
    if (error instanceof InvalidColumnFilterError) {
      return ctx.response.status(400).json({ error: error.message });
    }
    if (error instanceof CryptoError) {
      return ctx.response.status(error.status).json({ error: error.message, code: error.code });
    }
    this.options.logger.warn(
      `[@adonis-agora/crypto] console request failed: ${(error as Error).message}`,
    );
    return ctx.response.status(500).json({ error: 'crypto: internal error' });
  }

  #body(ctx: HttpContext): Record<string, unknown> {
    const body = ctx.request.body() as unknown;
    return typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
  }

  /** The app the operator picked. The console is a server surface, so it names it explicitly. */
  #partition(ctx: HttpContext): string {
    const query = ctx.request.qs() as Record<string, unknown>;
    const body = this.#body(ctx);
    const fromQuery = query.partition;
    const fromBody = body.partition;
    const value =
      typeof fromQuery === 'string' && fromQuery !== ''
        ? fromQuery
        : typeof fromBody === 'string' && fromBody !== ''
          ? fromBody
          : this.options.defaultPartition;
    if (!value) {
      throw new HttpError(400, 'partition is required (pick the app this console operates on)');
    }
    if (this.options.config.apps && !this.options.config.apps.includes(value)) {
      throw new HttpError(403, `app "${value}" is not served by this console`);
    }
    if (!consoleAppAllowed(value, this.options.config.apps, this.#grants.get(ctx))) {
      throw new HttpError(403, `app "${value}" is not granted to this viewer`);
    }
    return value;
  }

  async #actor(ctx: HttpContext): Promise<ConsoleActor> {
    return consoleActor(ctx);
  }

  /** The app's raw pick (`partition`, from the query or the body), before any check. */
  #picked(ctx: HttpContext): string | undefined {
    const query = ctx.request.qs() as Record<string, unknown>;
    const body = this.#body(ctx);
    if (typeof query.partition === 'string' && query.partition !== '') return query.partition;
    if (typeof body.partition === 'string' && body.partition !== '') return body.partition;
    return undefined;
  }

  /**
   * The other app a request is about, when it names a key of `console.federatedApps` (the
   * viewer's `apps` grant must name it too), else `undefined` for this console's own partitions.
   */
  async #federated(ctx: HttpContext): Promise<FederatedCryptoApp | undefined> {
    const picked = this.#picked(ctx);
    const federated = this.options.federated;
    if (picked === undefined || !federated?.has(picked)) return undefined;
    const grant = this.#grants.get(ctx);
    if (!(grant === undefined || grant === '*' || grant.includes(picked))) {
      throw new HttpError(403, `app "${picked}" is not granted to this viewer`);
    }
    return federated.get(picked);
  }

  /**
   * The service and principal a request reads with: another app's (metadata only, through its own
   * store) or this console's (full rights: it is the server).
   */
  async #reader(ctx: HttpContext): Promise<{ service: CryptoService; principal: CryptoPrincipal }> {
    const federated = await this.#federated(ctx);
    if (federated) {
      const actor = await this.#actor(ctx);
      return { service: federated.service, principal: federated.reader(actor.id) };
    }
    return { service: this.options.service, principal: await this.#principal(ctx) };
  }

  /** What a command to another app carries: the viewer (the actor) and what it was granted. */
  async #commandMeta(ctx: HttpContext): Promise<CommandMeta> {
    const actor = await this.#actor(ctx);
    const capabilities = this.#capabilities.get(ctx);
    return {
      actor: actor.id,
      ...(capabilities !== undefined ? { capabilities } : {}),
      ...(this.options.config.appLabel !== undefined ? { via: this.options.config.appLabel } : {}),
    };
  }

  /** Everything the console does acts for the operator, with full rights: it is the server. */
  async #principal(ctx: HttpContext): Promise<CryptoPrincipal> {
    const actor = await this.#actor(ctx);
    return {
      partition: this.#partition(ctx),
      capabilities: ['crypto:*'],
      actor: actor.id,
    };
  }

  async #shell(ctx: HttpContext) {
    const registry = this.options.registry;
    const viewer = await resolveViewer(ctx, this.options.config.viewer);
    const signOut = resolveSignOut(ctx, this.options.config.signOut, registry);
    const switcher = registry
      ? { endpoint: `${this.api}/consoles`, others: otherConsoles(registry, CONSOLE_ID) }
      : undefined;
    return {
      ...(viewer ? { viewer } : {}),
      ...(signOut ? { signOut } : {}),
      ...(switcher && switcher.others > 0 ? { switcher } : {}),
      ...(registry ? { search: { endpoint: `${this.api}/consoles/search` } } : {}),
    };
  }

  async spa(ctx: HttpContext) {
    if (!(await this.#guard(ctx, 'page'))) return;
    let html: string;
    try {
      html = await readFile(join(this.options.spaDir, 'index.html'), 'utf8');
    } catch {
      return ctx.response
        .status(503)
        .send('@adonis-agora/crypto-dashboard is not built: run `pnpm build` in the package.');
    }
    const shell = await this.#shell(ctx);
    const rendered = renderIndexHtml(
      html,
      this.options.config.path,
      this.api,
      {
        ...(this.options.defaultPartition &&
        consoleAppAllowed(
          this.options.defaultPartition,
          this.options.config.apps,
          this.#grants.get(ctx),
        )
          ? { app: this.options.defaultPartition }
          : {}),
      },
      shell,
    );
    ctx.response
      .header('content-type', 'text/html; charset=utf-8')
      .header('cache-control', 'no-store');
    return ctx.response.send(rendered);
  }

  async asset(ctx: HttpContext) {
    if (!(await this.#guard(ctx, 'page'))) return;
    const file = String((ctx.params as Record<string, string>).file ?? '');
    if (file === '' || file !== basename(file)) {
      return ctx.response.status(404).send('not found');
    }
    try {
      const bytes = await readFile(join(this.options.spaDir, 'assets', file));
      ctx.response
        .header('content-type', contentTypeFor(file))
        .header('cache-control', 'public, max-age=31536000, immutable');
      return ctx.response.send(bytes);
    } catch {
      return ctx.response.status(404).send('not found');
    }
  }

  async meta(ctx: HttpContext) {
    const actor = await this.#actor(ctx);
    const partitions = await this.options.service.store.partitions();
    const grant = this.#grants.get(ctx);
    const fallback = this.options.defaultPartition;
    // The static list (or every app the store holds), narrowed to the viewer's grant.
    const federated = this.#visibleFederated(ctx);
    // Another app's key names that app here, so a local partition of the same name is not listed.
    const apps = [
      ...consoleVisibleApps(
        this.options.config.apps ?? partitions,
        this.options.config.apps,
        grant,
      ).filter((app) => !this.options.federated?.has(app)),
      ...federated,
    ];
    const fallbackAllowed =
      fallback !== undefined && consoleAppAllowed(fallback, this.options.config.apps, grant);
    const defaultPartition =
      fallback && apps.includes(fallback)
        ? fallback
        : (apps[0] ?? ((fallbackAllowed && fallback) || ''));
    return ctx.response.header('cache-control', 'no-store').json({
      apps: apps.length > 0 ? apps : defaultPartition ? [defaultPartition] : [],
      defaultPartition,
      topology: this.options.topology,
      actor: actor.id,
      ...(federated.length > 0
        ? { federated: federated.map((id) => this.options.federated!.describe(id)) }
        : {}),
      keyTypes: ['aes256-gcm', 'x25519', 'ed25519', 'hmac-sha256'],
      capabilityLegend: [
        'crypto:encrypt:<key>',
        'crypto:decrypt:<key>',
        'crypto:rewrap:<key>',
        'crypto:datakey:<key>',
        'crypto:sign:<key>',
        'crypto:verify:<key>',
        'crypto:hmac:<key>',
        'crypto:keys:read',
        'crypto:keys:manage',
        'crypto:keys:export',
      ],
    });
  }

  /** The federated apps this viewer may see (`console.federatedApps` ∩ the `apps` grant). */
  #visibleFederated(ctx: HttpContext): string[] {
    const grant = this.#grants.get(ctx);
    return (this.options.federated?.ids ?? []).filter(
      (id) => grant === undefined || grant === '*' || grant.includes(id),
    );
  }

  /**
   * The App picker of the federated console, the shape every Agora console answers: this
   * console's own partitions are `local`, the other apps are listed with how they are reached.
   */
  async apps(ctx: HttpContext) {
    const federated = this.#visibleFederated(ctx);
    const picked = this.#picked(ctx) ?? (ctx.request.qs() as { app?: unknown }).app;
    return ctx.response.header('cache-control', 'no-store').json({
      local: { label: this.options.config.appLabel ?? 'This app' },
      apps: federated.map((id) => this.options.federated!.describe(id)),
      selected: typeof picked === 'string' && federated.includes(picked) ? picked : null,
    });
  }

  async overview(ctx: HttpContext) {
    const { service, principal } = await this.#reader(ctx);
    return ctx.response.header('cache-control', 'no-store').json(await service.overview(principal));
  }

  async listKeys(ctx: HttpContext) {
    const { service, principal } = await this.#reader(ctx);
    const list = parseListQuery(ctx.request.qs() as Record<string, unknown>, {
      sortable: ['name', 'createdAt', 'updatedAt'],
      defaultSort: { field: 'name', direction: 'asc' },
      filterable: [],
      defaultSize: 50,
      maxSize: 200,
    });
    const page: OffsetPage<CryptoKeyView> = await service.listKeys(principal, {
      page: list.page,
      size: list.size,
      ...(list.search !== undefined ? { search: list.search } : {}),
      sort: list.sort as { field: 'name' | 'createdAt' | 'updatedAt'; direction: 'asc' | 'desc' },
    });
    return ctx.response.json(page);
  }

  async getKey(ctx: HttpContext) {
    const { service, principal } = await this.#reader(ctx);
    return ctx.response
      .header('cache-control', 'no-store')
      .json(
        await service.getKey(principal, String((ctx.params as Record<string, string>).name ?? '')),
      );
  }

  async createKey(ctx: HttpContext) {
    const body = this.#body(ctx);
    if (typeof body.name !== 'string' || body.name === '') {
      throw new HttpError(400, 'name is required');
    }
    const type = body.type as CryptoKeyType;
    const federated = await this.#federated(ctx);
    if (federated) {
      const created = await federated.createKey(
        {
          name: body.name,
          type,
          ...(typeof body.description === 'string' ? { description: body.description } : {}),
          ...(typeof body.deletionAllowed === 'boolean'
            ? { deletionAllowed: body.deletionAllowed }
            : {}),
          ...(typeof body.exportable === 'boolean' ? { exportable: body.exportable } : {}),
        },
        await this.#commandMeta(ctx),
      );
      return ctx.response.status(201).json(created);
    }
    const principal = await this.#principal(ctx);
    const created = await this.options.service.createKey(principal, {
      name: body.name,
      type,
      ...(typeof body.description === 'string' && body.description !== ''
        ? { description: body.description }
        : {}),
      ...(typeof body.deletionAllowed === 'boolean'
        ? { deletionAllowed: body.deletionAllowed }
        : {}),
      ...(typeof body.exportable === 'boolean' ? { exportable: body.exportable } : {}),
    });
    return ctx.response.status(201).json(created);
  }

  async rotateKey(ctx: HttpContext) {
    const name = String((ctx.params as Record<string, string>).name ?? '');
    const federated = await this.#federated(ctx);
    if (federated) {
      return ctx.response.json(await federated.rotateKey(name, await this.#commandMeta(ctx)));
    }
    const principal = await this.#principal(ctx);
    return ctx.response.json(await this.options.service.rotateKey(principal, name));
  }

  /**
   * Exercise a key with a random probe (encrypt + decrypt, sign + verify, or HMAC): whether it
   * round-trips, never the probe, the ciphertext or the signature. Audited like any operation.
   */
  async testKey(ctx: HttpContext) {
    const name = String((ctx.params as Record<string, string>).name ?? '');
    const federated = await this.#federated(ctx);
    if (federated) {
      return ctx.response.json(await federated.testKey(name, await this.#commandMeta(ctx)));
    }
    const principal = await this.#principal(ctx);
    return ctx.response.json(await testKey(this.options.service, principal, name));
  }

  /** Re-encrypt a ciphertext under the key's latest version (the plaintext stays inside). */
  async rewrap(ctx: HttpContext) {
    const name = String((ctx.params as Record<string, string>).name ?? '');
    const body = this.#body(ctx);
    if (typeof body.ciphertext !== 'string' || body.ciphertext === '') {
      throw new HttpError(400, 'ciphertext is required');
    }
    const input = {
      ciphertext: body.ciphertext,
      ...(typeof body.aad === 'string' ? { aad: body.aad } : {}),
    };
    const federated = await this.#federated(ctx);
    if (federated) {
      return ctx.response.json(await federated.rewrap(name, input, await this.#commandMeta(ctx)));
    }
    const principal = await this.#principal(ctx);
    return ctx.response.json(
      await this.options.service.rewrap(principal, { key: name, ...input, context: 'console' }),
    );
  }

  async updateKey(ctx: HttpContext) {
    const body = this.#body(ctx);
    const name = String((ctx.params as Record<string, string>).name ?? '');
    const federated = await this.#federated(ctx);
    if (federated) {
      const patch = Object.fromEntries(
        ['description', 'minDecryptionVersion', 'deletionAllowed', 'exportable']
          .filter((field) => body[field] !== undefined)
          .map((field) => [field, body[field]]),
      );
      return ctx.response.json(
        await federated.updateKeyPolicy(name, patch, await this.#commandMeta(ctx)),
      );
    }
    const principal = await this.#principal(ctx);
    return ctx.response.json(
      await this.options.service.updateKeyPolicy(principal, name, {
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
  }

  async deleteKey(ctx: HttpContext) {
    const name = String((ctx.params as Record<string, string>).name ?? '');
    const federated = await this.#federated(ctx);
    if (federated) {
      return ctx.response.json(await federated.deleteKey(name, await this.#commandMeta(ctx)));
    }
    const principal = await this.#principal(ctx);
    return ctx.response.json(await this.options.service.deleteKey(principal, name));
  }

  async audit(ctx: HttpContext) {
    const { service, principal } = await this.#reader(ctx);
    const request = parseAuditRequest(ctx.request.qs() as Record<string, unknown>);
    return ctx.response.json(
      request.cursor
        ? await service.auditCursor(principal, request)
        : await service.audit(principal, request),
    );
  }

  async consoles(ctx: HttpContext) {
    return ctx.response.json(await listVisibleConsoles(this.options.registry, CONSOLE_ID, ctx));
  }

  async search(ctx: HttpContext) {
    const q = (ctx.request.qs() as { q?: string }).q ?? '';
    return ctx.response.json(await searchConsoles(this.options.registry, CONSOLE_ID, ctx, q));
  }
}

/** The console's global search, over the key names of the app the operator picked. */
export function cryptoConsoleSearchFor(
  service: CryptoService,
  base: string,
  /** Whether the viewer may see this app (the console's static `apps` and the viewer's grant). */
  appAllowed: (ctx: HttpContext, app: string) => Promise<boolean> = async () => true,
): (
  ctx: HttpContext,
  q: string,
  limit: number,
) => Promise<Array<{ title: string; subtitle?: string; href: string }>> {
  return cryptoConsoleSearch(async (ctx) => {
    // The switcher's ⌘K sends `app` (the shell picker); a console-local call may send `partition`.
    const query = ctx.request.qs() as { app?: string; partition?: string };
    const partition = query.partition ?? query.app ?? '';
    return {
      keys: async () => {
        if (partition === '' || !(await appAllowed(ctx, partition))) return [];
        const keys = await service.listKeys(
          { partition, capabilities: ['crypto:keys:read'], actor: 'console' },
          { page: 1, size: 200 },
        );
        return keys.data.filter((key) => key.deletedAt === undefined).map((key) => key.name);
      },
    };
  }, base);
}
