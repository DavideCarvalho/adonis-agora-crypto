/**
 * What telescope's Architecture page shows for the crypto server these seams call: the same
 * `kms agora-crypto` box as the KMS roots (`cryptoServerKms`), with what each seam uses it for.
 * Read by telescope under a global symbol, so nothing here depends on it.
 */
export const STACK_DESCRIPTOR = Symbol.for('@adonis-agora/stack');

export interface StackUse {
  tech: string;
  purpose?: string;
  label?: string;
  connection?: string;
  host?: string;
}

/** The crypto server, used for `purpose`. */
export function cryptoServerUse(purpose: string): StackUse {
  return { tech: 'kms', label: 'agora-crypto', purpose };
}

/** `existing` (another descriptor, or nothing) plus `use`. */
export function withUse(existing: unknown, use: StackUse): StackUse[] {
  return [...(Array.isArray(existing) ? (existing as StackUse[]) : []), use];
}

/** Attach `use` to `target` (non-enumerable, never throws). Returns `target`. */
export function describeStackUse<T extends object>(target: T, use: StackUse): T {
  try {
    Object.defineProperty(target, STACK_DESCRIPTOR, {
      value: withUse((target as Record<symbol, unknown>)[STACK_DESCRIPTOR], use),
      enumerable: false,
      configurable: true,
    });
  } catch {
    // a frozen target: nothing to describe
  }
  return target;
}
