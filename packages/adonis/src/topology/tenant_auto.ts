import type { ServerUrlSource, TenantTokenSource } from '@adonis-agora/crypto-core';

/**
 * Zero-config tenant topology: with `@adonis-agora/authkit-client` booted in this app (its
 * `service`), `defineConfig({ topology: 'tenant' })` is enough. The server URL, the token and the
 * partition come from the `'authkit.client'` binding's `tenantOf(resource)`. The binding is read
 * structurally: this package never imports authkit-client and does not depend on it.
 */

const PACKAGE = '@adonis-agora/crypto';

/** What `tenantOf(resource)` answers, as far as crypto uses it. */
export interface AuthkitTenant {
  url: (() => Promise<string>) & { refresh?(): Promise<string> };
  token: (() => Promise<string>) & { reset?(): void };
  partition: string;
}

/** The `'authkit.client'` binding, as far as tenant discovery uses it. */
export interface AuthkitTenantSource {
  tenantOf(resource: string): AuthkitTenant;
}

/** Where a tenant field came from. */
export type TenantFieldSource = 'authkit-client (auto)' | 'explicit' | 'missing';

/** The three fields a tenant needs, as `config/crypto.ts` may give them (each optional). */
export interface TenantFieldsInput {
  url?: ServerUrlSource;
  token?: TenantTokenSource;
  partition?: string;
  /** `false` turns authkit-client auto-detection off. Default `true`. */
  auto?: boolean;
}

export interface ResolvedTenantFields {
  url?: ServerUrlSource;
  token?: TenantTokenSource;
  partition?: string;
  sources: { url: TenantFieldSource; token: TenantFieldSource; partition: TenantFieldSource };
  /** The fields neither the config nor authkit-client supplied. */
  missing: Array<'url' | 'token' | 'partition'>;
  /** Why authkit-client could not supply them (its `tenantOf` threw), if it was asked. */
  cause?: string;
}

interface ContainerLike {
  hasBinding(binding: string): boolean;
  make(binding: string): Promise<unknown>;
}

/**
 * `@adonis-agora/authkit-client`'s binding when it is booted in this app and can discover tenants
 * (`tenantOf`), else `undefined`. An older authkit-client (no `tenantOf`) or a binding that fails
 * to resolve counts as absent.
 */
export async function authkitTenantSourceOf(
  container: unknown,
): Promise<AuthkitTenantSource | undefined> {
  const c = container as ContainerLike | undefined;
  if (typeof c?.hasBinding !== 'function' || !c.hasBinding('authkit.client')) return undefined;
  try {
    const client = (await c.make('authkit.client')) as { tenantOf?: unknown } | undefined;
    return typeof client?.tenantOf === 'function' ? (client as AuthkitTenantSource) : undefined;
  } catch {
    return undefined;
  }
}

const FIELDS = ['url', 'token', 'partition'] as const;

/**
 * Merges authkit-client's discovery under the explicit fields, field by field: anything set in
 * `config/crypto.ts` wins. `tenantOf` is only called when a field is missing and `auto` is not
 * `false`.
 */
export async function resolveTenantFields(
  container: unknown,
  tenant: TenantFieldsInput | undefined,
  resource: string,
): Promise<ResolvedTenantFields> {
  const explicit = tenant ?? {};
  const given = (field: (typeof FIELDS)[number]) =>
    explicit[field] !== undefined && explicit[field] !== null && explicit[field] !== '';
  let auto: AuthkitTenant | undefined;
  let cause: string | undefined;
  if (explicit.auto !== false && FIELDS.some((field) => !given(field))) {
    const source = await authkitTenantSourceOf(container);
    if (source) {
      try {
        auto = source.tenantOf(resource);
      } catch (error) {
        cause = error instanceof Error ? error.message : String(error);
      }
    }
  }
  const pick = <K extends (typeof FIELDS)[number]>(field: K) => {
    if (given(field)) return { value: explicit[field], source: 'explicit' as const };
    const value = auto?.[field];
    if (value !== undefined && value !== null && value !== '') {
      return { value, source: 'authkit-client (auto)' as const };
    }
    return { value: undefined, source: 'missing' as const };
  };
  const url = pick('url');
  const token = pick('token');
  const partition = pick('partition');
  const sources = { url: url.source, token: token.source, partition: partition.source };
  return {
    ...(url.value !== undefined ? { url: url.value as ServerUrlSource } : {}),
    ...(token.value !== undefined ? { token: token.value as TenantTokenSource } : {}),
    ...(partition.value !== undefined ? { partition: partition.value as string } : {}),
    sources,
    missing: FIELDS.filter((field) => sources[field] === 'missing'),
    ...(cause !== undefined ? { cause } : {}),
  };
}

/** The boot error when a tenant lacks fields and authkit-client could not supply them. */
export function tenantMissingMessage(resolved: Pick<ResolvedTenantFields, 'missing' | 'cause'>) {
  const fields = resolved.missing.map((field) => `tenant.${field}`).join(', ');
  const cause = resolved.cause ? ` (authkit-client: ${resolved.cause})` : '';
  return `[${PACKAGE}] topology 'tenant' needs ${fields}${cause}. Configure @adonis-agora/authkit-client's \`service\` (config/authkit_client.ts: service: { name, clientId, clientSecret }) so they are discovered from the issuer, or pass tenant: { url, token, partition } in config/crypto.ts.`;
}

/** `tenant url: authkit-client (auto), token: authkit-client (auto), partition: explicit`. */
export function describeTenantSources(sources: ResolvedTenantFields['sources']): string {
  return `tenant url: ${sources.url}, token: ${sources.token}, partition: ${sources.partition}`;
}
