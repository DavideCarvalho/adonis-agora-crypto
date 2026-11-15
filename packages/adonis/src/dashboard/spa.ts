/**
 * Pure helpers for mounting/serving the `@adonis-agora/crypto-dashboard` React SPA, split out so
 * they are unit-testable without booting AdonisJS. Same shape as the other Agora consoles.
 */

import type { ConsoleSignOut, ConsoleViewer } from './console_shell.js';

/** Placeholder base Vite bakes into asset URLs; rewritten to the configured path at serve time. */
export const BASE_PLACEHOLDER = '/__CRYPTO_DASHBOARD__/';

export const CONTENT_TYPES: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
};

export function contentTypeFor(file: string): string {
  const ext = file.slice(file.lastIndexOf('.'));
  return CONTENT_TYPES[ext] ?? 'application/octet-stream';
}

/** `id` of the JSON data block; `src/client/crypto-client.ts` reads it. */
export const CRYPTO_ELEMENT_ID = 'crypto-dashboard-config';

export interface SwitcherConfig {
  endpoint: string;
  others: number;
}

export interface ShellFields {
  switcher?: SwitcherConfig;
  search?: { endpoint: string };
  viewer?: ConsoleViewer;
  signOut?: ConsoleSignOut;
}

/** What the page tells the SPA about the deployment it is mounted in. */
export interface InjectedConfig extends ShellFields {
  base: string;
  api: string;
  app?: string;
  environment?: string;
  label?: string;
}

/**
 * Rewrite the built `index.html`: point Vite's placeholder base at the configured mount path and
 * hand the SPA its deployment config as a JSON data block (never an inline script, so a nonce'd CSP
 * cannot refuse it).
 */
export function renderIndexHtml(
  html: string,
  basePath: string,
  apiBasePath: string,
  defaults: { app?: string; environment?: string; label?: string } = {},
  extra: ShellFields = {},
): string {
  const based = html.split(BASE_PLACEHOLDER).join(`${basePath}/`);
  const config: InjectedConfig = {
    base: basePath,
    api: apiBasePath,
    ...(defaults.app !== undefined ? { app: defaults.app } : {}),
    ...(defaults.environment !== undefined ? { environment: defaults.environment } : {}),
    ...(defaults.label !== undefined ? { label: defaults.label } : {}),
    ...(extra.switcher && extra.switcher.others > 0 ? { switcher: extra.switcher } : {}),
    ...(extra.search ? { search: extra.search } : {}),
    ...(extra.viewer ? { viewer: extra.viewer } : {}),
    ...(extra.signOut ? { signOut: extra.signOut } : {}),
  };
  // `<` escaped, so a config value cannot close the data block early. Valid JSON either way.
  const json = JSON.stringify(config).replace(/</g, '\\u003c');
  const inject = `<script type="application/json" id="${CRYPTO_ELEMENT_ID}">${json}</script>`;
  return based.includes('</head>') ? based.replace('</head>', `${inject}</head>`) : inject + based;
}
