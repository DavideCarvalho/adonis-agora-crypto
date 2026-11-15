/**
 * The audit contract for a **recipient-held** open (`sealTo` / `openWith`): the crypto server never
 * sees it, so the app records it. This is the one shape every product emits, so Telescope (and any
 * other reader) shows the same identity in both models.
 *
 * Server-held (`crypto.decrypt`) needs none of this: the crypto server audits it, with the same
 * `actor ?? sub` rule.
 */

/** The diagnostics/Telescope event name a recipient-held open is emitted under. */
export const SEALED_OPEN_EVENT = 'crypto:sealed.open';

/** Who opened it: `actor ?? sub`, exactly like the crypto server's audit. */
export type SealedOpenActor = string | { sub?: string | undefined; email?: string | undefined };

export interface SealedOpenEventInput {
  /** `Identity.actor` when an agent acts for a person (RFC 8693 `act`), or a plain string. */
  actor?: SealedOpenActor | null | undefined;
  /** `Identity.sub` — the authenticated principal behind the open. */
  subject?: string | undefined;
  /** The key name the share was sealed to (the app's own key, e.g. `doctor-42`). */
  key: string;
  /** The `kid` the `agora:pk1` value names (the version that opened it). */
  kid?: string | undefined;
  /** What was opened, in the product's own vocabulary (a grant, an entry, an exam). */
  resource?: string | undefined;
  /** ISO timestamp. Default: now. */
  at?: string | undefined;
  /** `ok` (default) or `error` when the open was refused/failed. */
  result?: 'ok' | 'error' | undefined;
}

export interface SealedOpenEvent {
  event: typeof SEALED_OPEN_EVENT;
  v: 1;
  /** `actor ?? subject`: the same identity rule as the crypto server's audit. */
  actor: string;
  subject?: string;
  key: string;
  kid?: string;
  resource?: string;
  at: string;
  result: 'ok' | 'error';
}

const subjectOf = (actor: SealedOpenActor | null | undefined): string | undefined =>
  typeof actor === 'string' ? actor : actor?.sub;

/**
 * Builds the event an app emits when *it* opens a share:
 *
 * ```ts
 * const event = sealedOpenEvent({ actor: identity.actor, subject: identity.sub, key: 'doctor-42', kid, resource: `grant:${id}` })
 * emitter.emit(SEALED_OPEN_EVENT, event)
 * ```
 *
 * No actor and no subject is a programming error: an open without an identity would make the audit
 * lie, so it throws instead of emitting an anonymous row.
 */
export function sealedOpenEvent(input: SealedOpenEventInput): SealedOpenEvent {
  if (typeof input.key !== 'string' || input.key === '') {
    throw new Error('crypto: a sealed-open event needs the key name');
  }
  const actor = subjectOf(input.actor) ?? input.subject;
  if (actor === undefined || actor === '') {
    throw new Error(
      'crypto: a sealed-open event needs an identity (actor ?? subject); an anonymous open is not auditable',
    );
  }
  return {
    event: SEALED_OPEN_EVENT,
    v: 1,
    actor,
    ...(input.subject !== undefined ? { subject: input.subject } : {}),
    key: input.key,
    ...(input.kid !== undefined ? { kid: input.kid } : {}),
    ...(input.resource !== undefined ? { resource: input.resource } : {}),
    at: input.at ?? new Date().toISOString(),
    result: input.result ?? 'ok',
  };
}
