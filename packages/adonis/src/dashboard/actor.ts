import type { HttpContext } from '@adonisjs/core/http';

/** Who is acting in the console: `act` (RFC 8693 impersonation) when present, else `sub`. */
export interface ConsoleActor {
  id: string;
  email?: string;
}

const IDENTITY_TIMEOUT_MS = 250;

function read(source: unknown, key: string): unknown {
  if (typeof source !== 'object' || source === null) return undefined;
  try {
    return (source as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

function text(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

/**
 * Resolves the audit actor, structurally: authkit's per-request identity when there is one. Wave 1
 * exposes the impersonator as `identity.actor` (`{ sub, email? }`); older tokens carry the same data
 * in `identity.raw.act` (RFC 8693), and `ctx.auth.user` is the no-authkit fallback. The subject
 * authorizes; the actor is what the audit trail records — `actor ?? sub`, exactly the convention.
 */
export async function consoleActor(ctx: HttpContext): Promise<ConsoleActor> {
  const authkit = read(ctx, 'authkit');
  let identity = read(authkit, 'identity');
  const getIdentity = read(authkit, 'getIdentity');
  if ((identity === null || identity === undefined) && typeof getIdentity === 'function') {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      identity = await Promise.race([
        Promise.resolve(getIdentity.call(authkit)),
        new Promise<undefined>((resolve) => {
          timer = setTimeout(() => resolve(undefined), IDENTITY_TIMEOUT_MS);
        }),
      ]);
    } catch {
      identity = undefined;
    } finally {
      clearTimeout(timer);
    }
  }
  const user = read(read(ctx, 'auth'), 'user');
  const sub =
    text(read(identity, 'userId')) ?? text(read(user, 'id')) ?? text(read(user, 'userId'));
  const act = read(identity, 'actor');
  const legacyAct = read(read(identity, 'raw'), 'act');
  const userAct = read(user, 'actor');
  const actor =
    text(read(act, 'sub')) ??
    text(read(legacyAct, 'sub')) ??
    text(read(userAct, 'sub')) ??
    text(read(user, 'act'));
  const email =
    text(read(act, 'email')) ??
    text(read(identity, 'email')) ??
    text(read(userAct, 'email')) ??
    text(read(user, 'email'));
  const id = actor ?? sub ?? 'console';
  return { id, ...(email ? { email } : {}) };
}
