/** Where a client gets the bearer token it presents to the crypto server. */
export interface TenantToken {
  get(): Promise<string>;
  /** Drops a cached token (after a 401), so the next `get` fetches a fresh one. */
  reset?(): void;
}

/**
 * A fixed secret, a function returning a token (`authkitTenantToken(...)` from
 * `@adonis-agora/authkit-client`), or an object with `get()`.
 *
 * `authkitTenantToken` returns a function with a `reset()`: a 401 calls it, so the next request
 * fetches a fresh token instead of retrying the cached one.
 */
export type TenantTokenSource =
  | string
  | (() => Promise<string>)
  | { get(): Promise<string>; reset?(): void; invalidate?(): void };

/** Normalizes every accepted token source into {@link TenantToken}. */
export function resolveTenantToken(source: TenantTokenSource): TenantToken {
  if (typeof source === 'string') {
    if (source === '') throw new Error('crypto: the token is empty');
    return { get: async () => source };
  }
  if (typeof source === 'function') {
    const reset = (source as { reset?: unknown }).reset;
    return {
      get: () => source(),
      ...(typeof reset === 'function' ? { reset: () => reset.call(source) } : {}),
    };
  }
  if (source && typeof source === 'object' && typeof source.get === 'function') {
    const reset = source.reset ?? source.invalidate;
    return {
      get: () => source.get(),
      ...(typeof reset === 'function' ? { reset: () => reset.call(source) } : {}),
    };
  }
  throw new Error(
    'crypto: a token source must be a string, a function returning a token, or an object with get()',
  );
}
