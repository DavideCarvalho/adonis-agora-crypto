import { capabilityAllows } from '@adonis-agora/crypto-core';
import {
  type ConsoleCapabilityKind,
  type ConsoleCapabilityTable,
  consoleCapabilityAllows,
} from '../dashboard/console_capabilities.js';

/**
 * crypto's console capabilities, on top of the canonical matcher (`console_capabilities.ts`,
 * byte-identical across the Agora libs). Two grammars meet here:
 *
 * - **console capabilities** — `crypto:keys:read` (read), `crypto:keys:manage` (write) and the
 *   uniform aliases (`crypto:console:read`, `crypto:console:write`, `crypto:console:*`,
 *   `crypto:*`, `*`), matched ONLY by `consoleCapabilityAllows`: `crypto:*:manage`,
 *   `*:keys:manage` or `crypto:console:w*` grant nothing;
 * - **data operations on a key** — `crypto:<op>:<key-pattern>` (`crypto:encrypt:orders`,
 *   `crypto:decrypt:subject_*`) and the key-scoped `crypto:keys:<read|manage>:<key-pattern>` —
 *   which keep crypto's own key matcher, but only when the operation segment is literal.
 *
 * A key test (encrypt/decrypt, sign/verify, hmac) and a rewrap are writes for the aliases: a
 * read-only viewer runs neither.
 */

/** The data operations a console command may need on a key. */
const DATA_OPS = ['encrypt', 'decrypt', 'sign', 'verify', 'hmac', 'rewrap'] as const;

/** crypto's console table: which console capabilities read and which write. */
export const CRYPTO_CONSOLE_TABLE: ConsoleCapabilityTable = {
  'crypto:keys:read': 'read',
  'crypto:keys:manage': 'write',
  ...Object.fromEntries(DATA_OPS.map((op) => [`crypto:${op}:*`, 'write'])),
};

/** Everything a viewer may do when `authorize` names no capabilities (never export, never datakey). */
export const CRYPTO_CONSOLE_CAPABILITIES: readonly string[] = Object.keys(CRYPTO_CONSOLE_TABLE);

/** `crypto:<literal op>:<one key pattern>`, or `crypto:keys:<read|manage>:<one key pattern>`. */
const DATA_GRANT = new RegExp(
  `^crypto:(?:(?:${DATA_OPS.join('|')})|keys:(?:read|manage)):[^:*]*\\*?$`,
);

/** Whether `capability` is a data operation on one key (or a key-scoped keys capability). */
function isKeyed(capability: string): boolean {
  return DATA_GRANT.test(capability) && !capability.endsWith(':*');
}

/** How a required capability reads or writes, for the aliases. */
function kindOf(required: string): ConsoleCapabilityKind | undefined {
  if (required === 'crypto:keys:read' || required.startsWith('crypto:keys:read:')) return 'read';
  if (required === 'crypto:keys:manage' || required.startsWith('crypto:keys:manage:')) {
    return 'write';
  }
  return DATA_OPS.some((op) => required.startsWith(`crypto:${op}:`)) ? 'write' : undefined;
}

/**
 * Whether `granted` (a token's, a viewer's, or an app's `consoleCommands.capabilities`) allows
 * `required`. Console capabilities and aliases through the canonical matcher; a key-pattern grant
 * (`crypto:decrypt:subject_*`) through crypto's key matcher, and only for a keyed `required`.
 */
export function cryptoConsoleAllows(
  granted: readonly unknown[] | undefined,
  required: string,
): boolean {
  if (!Array.isArray(granted)) return false;
  const kind = kindOf(required);
  const table =
    kind === undefined ? CRYPTO_CONSOLE_TABLE : { ...CRYPTO_CONSOLE_TABLE, [required]: kind };
  if (consoleCapabilityAllows(granted, required, table)) return true;
  if (!isKeyed(required)) return false;
  const keyed = granted.filter((g): g is string => typeof g === 'string' && DATA_GRANT.test(g));
  return capabilityAllows(keyed, required);
}

/**
 * What a console viewer may do (§4b), narrowed to crypto's console set: the set's entries its
 * grant allows (aliases expanded by the canonical matcher), plus its well-formed key-pattern grants;
 * the whole set when `authorize` names none. `access: 'read'` keeps the read set only. Never
 * `crypto:keys:export`, never a look-alike wildcard.
 */
export function viewerConsoleCapabilities(
  granted: readonly string[] | undefined,
  access?: 'read' | 'write' | undefined,
): string[] {
  const list = granted === undefined ? [...CRYPTO_CONSOLE_CAPABILITIES] : granted;
  const out = new Set<string>();
  for (const capability of CRYPTO_CONSOLE_CAPABILITIES) {
    if (cryptoConsoleAllows(list, capability)) out.add(capability);
  }
  for (const capability of list) {
    if (typeof capability === 'string' && isKeyed(capability)) out.add(capability);
  }
  const all = [...out];
  if (access !== 'read') return all;
  return all.filter((c) => kindOf(c) === 'read');
}

/** The concrete capabilities one console command may use on key `name`, by verb. */
export function commandCandidates(verb: string, name: string): string[] {
  switch (verb) {
    case 'createKey':
    case 'deleteKey':
      return ['crypto:keys:manage', `crypto:keys:manage:${name}`];
    case 'rotateKey':
    case 'updateKeyPolicy':
      return ['crypto:keys:manage'];
    case 'testKey':
      return ['encrypt', 'decrypt', 'sign', 'verify', 'hmac'].map((op) => `crypto:${op}:${name}`);
    case 'rewrap':
      return ['rewrap', 'encrypt', 'decrypt'].map((op) => `crypto:${op}:${name}`);
    default:
      return [];
  }
}

/**
 * The capability a verb needs at the least (any one of these), checked before anything else on
 * the app (§10.18); the service then checks the exact operations.
 */
export function commandRequirement(verb: string, name: string): string[] {
  switch (verb) {
    case 'testKey':
      return ['encrypt', 'sign', 'hmac'].map((op) => `crypto:${op}:${name}`);
    case 'rewrap':
      return [`crypto:rewrap:${name}`];
    default:
      return commandCandidates(verb, name);
  }
}
