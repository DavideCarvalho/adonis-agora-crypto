import type { HttpContext } from '@adonisjs/core/http';
import { describe, expect, it } from 'vitest';
import { cryptoConsoleSearchFor } from '../../src/dashboard/console.js';
import { consoleAppAllowed } from '../../src/dashboard/console_apps.js';
import {
  anyAuthorize,
  authorizeByToken,
  normalizeConsoleAuthorizeResult,
  resolveConsoleAuthorize,
} from '../../src/dashboard/console_authorize.js';
import { cryptoDevTools } from '../../src/dev_tools.js';
import { memoryCrypto } from '../../src/testing/index.js';

const ctxWith = (headers: Record<string, string> = {}, qs: Record<string, string> = {}) =>
  ({
    request: {
      header: (name: string) => headers[name],
      qs: () => qs,
    },
  }) as unknown as HttpContext;

describe('console apps grant', () => {
  it('normalizes `apps` on an allow and drops junk', () => {
    expect(normalizeConsoleAuthorizeResult({ allowed: true, apps: ['a', 3, '', 'b'] })).toEqual({
      allowed: true,
      apps: ['a', '3', 'b'],
    });
    expect(normalizeConsoleAuthorizeResult({ allowed: true, apps: '*' })).toEqual({
      allowed: true,
      apps: '*',
    });
    // Malformed narrows to none; malformed capabilities grant nothing (fail closed).
    expect(normalizeConsoleAuthorizeResult({ allowed: true, apps: 'a' })).toEqual({
      allowed: true,
      apps: [],
    });
    expect(normalizeConsoleAuthorizeResult({ allowed: true, capabilities: 'crypto:*' })).toEqual({
      allowed: true,
      capabilities: [],
    });
    expect(
      normalizeConsoleAuthorizeResult({ allowed: true, tenants: ['t'], access: 'read' }),
    ).toEqual({ allowed: true, tenants: ['t'], access: 'read' });
    expect(normalizeConsoleAuthorizeResult(true)).toEqual({ allowed: true });
  });

  it('applies the static list first, then the grant', () => {
    expect(consoleAppAllowed('a', undefined, undefined)).toBe(true);
    expect(consoleAppAllowed('a', undefined, '*')).toBe(true);
    expect(consoleAppAllowed('a', ['b'], '*')).toBe(false);
    expect(consoleAppAllowed('a', undefined, ['b'])).toBe(false);
    expect(consoleAppAllowed('a', ['a', 'b'], ['a'])).toBe(true);
    expect(consoleAppAllowed('a', undefined, [])).toBe(false);
  });

  it('anyAuthorize keeps the deciding grant whole', async () => {
    const token = authorizeByToken({ token: 'secret' });
    const guard = resolveConsoleAuthorize(
      anyAuthorize(token, () => ({
        allowed: true,
        apps: ['shop'],
        capabilities: ['crypto:console:read'],
        access: 'read',
      })),
    );
    expect(await guard(ctxWith({ authorization: 'Bearer secret' }))).toEqual({ allowed: true });
    expect(await guard(ctxWith())).toEqual({
      allowed: true,
      apps: ['shop'],
      capabilities: ['crypto:console:read'],
      access: 'read',
    });
    const scoped = resolveConsoleAuthorize(
      authorizeByToken({ token: 'secret', apps: ['shop'], access: 'read' }),
    );
    expect(await scoped(ctxWith({ authorization: 'Bearer secret' }))).toEqual({
      allowed: true,
      apps: ['shop'],
      access: 'read',
    });
    const only = resolveConsoleAuthorize(anyAuthorize(() => false, token));
    expect(await only(ctxWith())).toMatchObject({ allowed: false, status: 401 });
  });

  it('the ⌘K search and the dev tools stay inside the grant', async () => {
    const crypto = memoryCrypto();
    await crypto.service.createKey(
      { partition: 'blog', capabilities: ['crypto:*'], actor: 't' },
      { name: 'posts', type: 'aes256-gcm' },
    );
    const allowed = async (_ctx: HttpContext, app: string) => app === 'shop';
    const search = cryptoConsoleSearchFor(crypto.service, '/_crypto', allowed);
    expect(await search(ctxWith({}, { app: 'blog' }), 'posts', 10)).toEqual([]);
    const open = cryptoConsoleSearchFor(crypto.service, '/_crypto');
    expect(await open(ctxWith({}, { app: 'blog' }), 'posts', 10)).not.toEqual([]);

    const tools = cryptoDevTools(crypto.service, { actorFor: () => 'mcp:t', appAllowed: allowed });
    const list = tools.find((tool) => tool.name === 'crypto_list_keys')!;
    const call = {
      ctx: ctxWith(),
      caller: { id: 't', via: 'token' as const },
      limits: { maxRows: 50, maxBytes: 100_000 },
    };
    await expect(list.run({ app: 'blog' }, call)).rejects.toThrow(/not granted/);
    await expect(list.run({ app: 'shop' }, call)).resolves.toMatchObject({ items: [] });
  });
});
