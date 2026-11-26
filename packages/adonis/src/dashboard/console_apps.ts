/**
 * Which apps (partitions) a viewer may operate on: the console's static `apps` (when set) and the
 * viewer's `apps` grant from `authorize` (`'*'` or omitted: every app). Kept out of
 * `console_authorize.ts`, which is byte-identical across the Agora libs.
 */
export function consoleAppAllowed(
  app: string,
  staticApps: readonly string[] | undefined,
  grant: '*' | string[] | undefined,
): boolean {
  if (staticApps !== undefined && !staticApps.includes(app)) return false;
  return grant === undefined || grant === '*' || grant.includes(app);
}

/** The apps of `all` a viewer may see (see {@link consoleAppAllowed}). */
export function consoleVisibleApps(
  all: readonly string[],
  staticApps: readonly string[] | undefined,
  grant: '*' | string[] | undefined,
): string[] {
  return all.filter((app) => consoleAppAllowed(app, staticApps, grant));
}
