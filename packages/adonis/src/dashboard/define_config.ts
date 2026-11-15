import type { HttpContext } from '@adonisjs/core/http';
import type { AccessDeniedOption } from './access_denied_page.js';
import type { ConsoleAuthorize } from './console_authorize.js';
import type { SignOutOption, ViewerHook } from './console_shell.js';

/** The console's configuration, under `console` on a standalone app or a control plane. */
export interface CryptoDashboardConfig {
  /** Mount the console. Default `true` on a control plane or standalone app. */
  enabled?: boolean;
  /**
   * UI and API mount path. Default `/_crypto` (the same prefix as the tenant API, which owns /v1).
   */
  path?: string;
  /**
   * Who may open the console. The same contract as every Agora console: a function, an authorizer
   * class, or a lazy import. Omitted: open outside production, every request denied in production.
   */
  authorize?: ConsoleAuthorize;
  /** Who is signed in, for the sidebar footer. Default: a structural read of `ctx.auth`/`ctx.authkit`. */
  viewer?: ViewerHook;
  /** How the footer signs out (a path, `{ action }`, `{ href }`, or `false`). */
  signOut?: SignOutOption;
  /** The refusal page, when `authorize` says no. */
  accessDenied?: AccessDeniedOption<HttpContext>;
  /** Where the refusal's "Sign in" points. */
  loginHref?: string;
  /**
   * Only these apps, when set. The picker lists them and a request for another app is refused.
   * Default: every app the store holds.
   */
  apps?: string[];
}

export interface ResolvedConsoleConfig {
  enabled: boolean;
  path: string;
  api: string;
  authorize?: ConsoleAuthorize;
  viewer?: ViewerHook;
  signOut?: SignOutOption;
  accessDenied?: AccessDeniedOption<HttpContext>;
  loginHref?: string;
  apps?: string[];
}

/** Normalizes the mount path: a same-origin absolute path, no trailing slash (root is `''`). */
export function dashboardPath(path: string | undefined): string {
  const value = (path ?? '/_crypto').trim();
  if (value === '' || value === '/') return '';
  if (!value.startsWith('/') || value.startsWith('//') || value.includes('\\')) {
    throw new Error(
      `[@adonis-agora/crypto] console.path must start with a single "/" (got ${JSON.stringify(path)})`,
    );
  }
  return value.replace(/\/$/, '');
}

/** Fills the defaults. */
export function resolveDashboardConfig(
  config: CryptoDashboardConfig | false | undefined,
  options: { environment?: string } = {},
): ResolvedConsoleConfig {
  void options;
  const provided = config === false ? { enabled: false } : (config ?? {});
  const path = dashboardPath(provided.path);
  return {
    enabled: provided.enabled ?? true,
    path,
    api: `${path}/api`,
    ...(provided.authorize ? { authorize: provided.authorize } : {}),
    ...(provided.viewer ? { viewer: provided.viewer } : {}),
    ...(provided.signOut !== undefined ? { signOut: provided.signOut } : {}),
    ...(provided.accessDenied ? { accessDenied: provided.accessDenied } : {}),
    ...(provided.loginHref ? { loginHref: provided.loginHref } : {}),
    ...(provided.apps ? { apps: provided.apps } : {}),
  };
}
