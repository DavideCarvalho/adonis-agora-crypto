import type { HttpContext } from '@adonisjs/core/http';
import type { CryptoService } from './crypto/service.js';

/*
 * The dev-tools registration contract, version 1, declared STRUCTURALLY: the hub is bound at
 * `'agora.devTools'` by `@adonis-agora/agent/mcp_provider` when the app has it, and this package
 * never imports the agent (it stays an optional, undeclared peer).
 */

export const DEV_TOOLS_BINDING = 'agora.devTools';

export interface DevToolsHub {
  readonly version: 1;
  register(lib: DevToolsLib): void;
}

export interface DevToolsLib {
  lib: string;
  title: string;
  authorize(ctx: HttpContext): Promise<DevToolsDecision>;
  tools: DevTool[];
}

export type DevToolsDecision =
  | { allowed: true }
  | {
      allowed: false;
      reason: 'unauthenticated' | 'forbidden';
      redirectTo?: string;
      error?: unknown;
    };

export interface DevTool {
  name: string;
  kind: 'read' | 'action';
  description: string;
  input: DevToolInputSchema;
  destructive?: boolean;
  available?(): boolean | Promise<boolean>;
  run(input: Record<string, unknown>, call: DevToolCall): Promise<unknown>;
}

export interface DevToolCall {
  ctx: HttpContext;
  caller: { id: string; via: 'token' | 'session' | 'open' };
  limits: { maxRows: number; maxBytes: number };
}

export interface DevToolInputProperty {
  type: 'string' | 'number' | 'integer' | 'boolean' | 'array';
  description?: string;
  enum?: readonly string[];
  items?: { type: 'string' };
  minimum?: number;
  maximum?: number;
}

export interface DevToolInputSchema {
  type: 'object';
  properties: Record<string, DevToolInputProperty>;
  required?: string[];
}

class DevToolError extends Error {}

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

function str(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function required(input: Record<string, unknown>, key: string): string {
  const value = str(input, key);
  if (value === undefined) throw new DevToolError(`${key} is required`);
  return value;
}

function paging(input: Record<string, unknown>, call: DevToolCall) {
  const rawLimit = input.limit;
  const limit =
    typeof rawLimit === 'number' && Number.isFinite(rawLimit)
      ? Math.trunc(rawLimit)
      : DEFAULT_LIMIT;
  const cap = Math.min(MAX_LIMIT, call.limits.maxRows > 0 ? call.limits.maxRows : MAX_LIMIT);
  const rawPage = input.page;
  const page = typeof rawPage === 'number' && Number.isFinite(rawPage) ? Math.trunc(rawPage) : 1;
  return { page: Math.max(1, page), size: Math.min(Math.max(limit, 1), cap) };
}

const APP: DevToolInputProperty = {
  type: 'string',
  description: 'Application (partition) the key belongs to.',
};
const KEY: DevToolInputProperty = { type: 'string', description: 'Key name.' };
const PAGE: DevToolInputProperty = {
  type: 'integer',
  minimum: 1,
  description: 'Page number, 1-based. Pass `next` back here.',
};
const LIMIT: DevToolInputProperty = {
  type: 'integer',
  minimum: 1,
  maximum: MAX_LIMIT,
  description: `Rows per page (default ${DEFAULT_LIMIT}, at most ${MAX_LIMIT}).`,
};

/**
 * The crypto console's developer tools: **metadata only**. Keys, versions, policy and the audit
 * trail — never a plaintext, never key material, and no encrypt/decrypt/sign tool at all. An agent
 * reads what exists and who did what; operations stay in the app's own code.
 *
 * Every read acts as `crypto:keys:read` on the named app, with the caller recorded as
 * `mcp:<caller id>`.
 */
export function cryptoDevTools(
  service: CryptoService,
  options: {
    actorFor: (call: DevToolCall) => string;
    /** Whether the caller may read this app (the console's static `apps` and its grant). */
    appAllowed?: (ctx: HttpContext, app: string) => Promise<boolean>;
  },
): DevTool[] {
  const read = async (input: Record<string, unknown>, call: DevToolCall) => {
    const partition = required(input, 'app');
    if (options.appAllowed && !(await options.appAllowed(call.ctx, partition))) {
      throw new Error(`crypto: app "${partition}" is not granted to this caller`);
    }
    return { partition, capabilities: ['crypto:keys:read'], actor: options.actorFor(call) };
  };

  return [
    {
      name: 'crypto_list_keys',
      kind: 'read',
      description:
        'List the keys of one app: name, type, latest version, decryption floor, whether deletion or export is allowed, and whether the key is deleted. Filters: `search`. Returns { items, next }.',
      input: {
        type: 'object',
        properties: {
          app: APP,
          search: { type: 'string', description: 'Substring of the name or description.' },
          page: PAGE,
          limit: LIMIT,
        },
        required: ['app'],
      },
      run: async (input, call) => {
        const principal = await read(input, call);
        const { page, size } = paging(input, call);
        const result = await service.listKeys(principal, {
          page,
          size,
          ...(str(input, 'search') !== undefined ? { search: str(input, 'search')! } : {}),
        });
        return {
          items: result.data.map((key) => ({
            name: key.name,
            type: key.type,
            latestVersion: key.latestVersion,
            minDecryptionVersion: key.minDecryptionVersion,
            deletionAllowed: key.deletionAllowed,
            exportable: key.exportable,
            versions: key.versions.length,
            createdAt: key.createdAt,
            createdBy: key.createdBy,
            ...(key.description !== undefined ? { description: key.description } : {}),
            ...(key.deletedAt !== undefined ? { deletedAt: key.deletedAt } : {}),
          })),
          next: result.meta.currentPage < result.meta.lastPage ? result.meta.currentPage + 1 : null,
        };
      },
    },
    {
      name: 'crypto_get_key',
      kind: 'read',
      description:
        'One key as metadata: type, policy, and every version with its status (`latest`, `decryptable`, `retired`), `kid` and public JWK. Never returns key material or ciphertext.',
      input: {
        type: 'object',
        properties: { app: APP, key: KEY },
        required: ['app', 'key'],
      },
      run: async (input, call) => {
        const view = await service.getKey(await read(input, call), required(input, 'key'));
        return view;
      },
    },
    {
      name: 'crypto_list_audit',
      kind: 'read',
      description:
        'The audit trail of one app: who did what (operation, key, version, result, error), newest first. Never contains plaintext or key material. Filters: `key`, `operation`, `result`, `actor`. Returns { items, next }.',
      input: {
        type: 'object',
        properties: {
          app: APP,
          key: KEY,
          operation: {
            type: 'string',
            description:
              'encrypt, decrypt, rewrap, datakey, sign, verify, hmac, public-key, read, create, rotate, policy, delete, export.',
          },
          result: { type: 'string', enum: ['ok', 'denied', 'error'] },
          actor: { type: 'string', description: 'Exact actor, e.g. `cli:davi` or `mcp:abc`.' },
          page: PAGE,
          limit: LIMIT,
        },
        required: ['app'],
      },
      run: async (input, call) => {
        const principal = await read(input, call);
        const { page, size } = paging(input, call);
        const result = await service.audit(principal, {
          page,
          size,
          sort: 'desc',
          filters: {
            ...(str(input, 'key') !== undefined ? { key: str(input, 'key')! } : {}),
            ...(str(input, 'operation') !== undefined
              ? { operation: str(input, 'operation')! }
              : {}),
            ...(str(input, 'result') !== undefined ? { result: str(input, 'result')! } : {}),
            ...(str(input, 'actor') !== undefined ? { actor: str(input, 'actor')! } : {}),
          },
        });
        return {
          items: result.data,
          next: result.meta.currentPage < result.meta.lastPage ? result.meta.currentPage + 1 : null,
        };
      },
    },
    {
      name: 'crypto_overview',
      kind: 'read',
      description:
        'Counters for one app: keys, versions, operations in the last 24h, denied and failed operations, and when the last operation happened.',
      input: { type: 'object', properties: { app: APP }, required: ['app'] },
      run: async (input, call) => service.overview(await read(input, call)),
    },
  ];
}

/** Registers the crypto tools into the app's dev-tools hub, when one is bound. */
export async function registerCryptoDevTools(
  container: { hasBinding(binding: string): boolean; make(binding: string): Promise<unknown> },
  options: {
    service: CryptoService;
    authorize: (ctx: HttpContext) => Promise<DevToolsDecision>;
    actorFor?: (call: DevToolCall) => string;
    appAllowed?: (ctx: HttpContext, app: string) => Promise<boolean>;
  },
): Promise<boolean> {
  if (!container.hasBinding(DEV_TOOLS_BINDING)) return false;
  const hub = (await container.make(DEV_TOOLS_BINDING)) as Partial<DevToolsHub> | undefined;
  if (hub?.version !== 1 || typeof hub.register !== 'function') return false;
  hub.register({
    lib: 'crypto',
    title: 'Crypto keys',
    authorize: options.authorize,
    tools: cryptoDevTools(options.service, {
      actorFor: options.actorFor ?? ((call) => `mcp:${call.caller.id}`),
      ...(options.appAllowed ? { appAllowed: options.appAllowed } : {}),
    }),
  });
  return true;
}
