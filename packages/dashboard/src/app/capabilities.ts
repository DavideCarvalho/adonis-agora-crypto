import {
  type ConsoleCapabilityKind,
  type ConsoleCapabilityTable,
  consoleCapabilityAllows,
} from './console_capabilities';

/**
 * The page's mirror of the server's `cryptoConsoleAllows` (it only hides buttons; the server
 * refuses anyway). Console capabilities and aliases go through the canonical matcher
 * (`console_capabilities.ts`, byte-identical across the Agora libs); a key-pattern grant
 * (`crypto:encrypt:subject_*`) only matches a keyed capability, and only with a literal operation.
 */

const DATA_OPS = ['encrypt', 'decrypt', 'sign', 'verify', 'hmac', 'rewrap'];

const TABLE: ConsoleCapabilityTable = {
  'crypto:keys:read': 'read',
  'crypto:keys:manage': 'write',
  ...Object.fromEntries(DATA_OPS.map((op) => [`crypto:${op}:*`, 'write'])),
};

const DATA_GRANT = new RegExp(
  `^crypto:(?:(?:${DATA_OPS.join('|')})|keys:(?:read|manage)):([^:*]*)(\\*?)$`,
);

function kindOf(required: string): ConsoleCapabilityKind | undefined {
  if (required.startsWith('crypto:keys:read')) return 'read';
  if (required.startsWith('crypto:keys:manage')) return 'write';
  return DATA_OPS.some((op) => required.startsWith(`crypto:${op}:`)) ? 'write' : undefined;
}

/** Whether a key-pattern grant covers a keyed `required` (same prefix, exact or `prefix*` key). */
function keyedAllows(grant: string, required: string): boolean {
  const g = DATA_GRANT.exec(grant);
  if (!g) return false;
  const base = grant.slice(0, grant.length - (g[1] ?? '').length - (g[2] ?? '').length);
  if (!required.startsWith(base)) return false;
  const key = required.slice(base.length);
  if (key === '' || key.includes(':')) return false;
  return g[2] === '*' ? key.startsWith(g[1] ?? '') : key === g[1];
}

/** Whether `capabilities` allow `required` (see the module comment). */
export function consoleAllows(capabilities: readonly string[], required: string): boolean {
  const kind = kindOf(required);
  const table = kind === undefined ? TABLE : { ...TABLE, [required]: kind };
  if (consoleCapabilityAllows(capabilities, required, table)) return true;
  return capabilities.some((grant) => keyedAllows(grant, required));
}

/**
 * Whether the viewer's console grant covers `crypto:keys:manage` (for any key). `undefined` (an
 * older server): everything is offered and the server still refuses.
 */
export function mayManageKeys(capabilities: readonly string[] | undefined): boolean {
  if (capabilities === undefined) return true;
  return (
    consoleAllows(capabilities, 'crypto:keys:manage') ||
    capabilities.some((c) => DATA_GRANT.test(c) && c.startsWith('crypto:keys:manage:'))
  );
}

/** Why key changes are unavailable to this viewer, or undefined when its grant allows them. */
export function manageDeniedReason(
  capabilities: readonly string[] | undefined,
): string | undefined {
  return mayManageKeys(capabilities)
    ? undefined
    : 'Your console access is read-only here: changing keys needs crypto:keys:manage';
}

/** The operations a key test runs, by key type (the server's `keyTestCapabilities`). */
function testOperations(type: string | undefined): string[] {
  if (type === 'ed25519') return ['sign', 'verify'];
  if (type === 'hmac-sha256') return ['hmac'];
  return ['encrypt', 'decrypt'];
}

/** Why this viewer may not test `key`, or undefined when its grant covers the test's operations. */
export function testDeniedReason(
  capabilities: readonly string[] | undefined,
  key: string,
  type: string | undefined,
): string | undefined {
  if (capabilities === undefined) return undefined;
  const missing = testOperations(type).find(
    (op) => !consoleAllows(capabilities, `crypto:${op}:${key}`),
  );
  return missing === undefined
    ? undefined
    : `Your console access cannot test this key: it needs crypto:${missing}:${key}`;
}
