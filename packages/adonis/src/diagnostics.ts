import { channel } from 'node:diagnostics_channel';

/**
 * Crypto's `@adonis-agora/diagnostics` events, published on `agora:crypto:<event>` through the emit
 * function diagnostics registers on its global slot: this package never imports it, and emitting is
 * a no-op when it is not installed.
 *
 * Who emits: the process that runs the operation. A standalone app and a control plane run them in
 * process and emit with `app` = the partition the operation acted on (on a control plane, the
 * tenant named by the verified token). A tenant sends its operations to the control plane, which
 * emits them; the tenant emits only what the control plane cannot see (its subject data-key cache,
 * and the local half of `forget`).
 *
 * Payloads never carry plaintext, ciphertext, key material, AAD or audit context values: only the
 * operation, the key name, the outcome, an error code, sizes and the duration.
 */
const EMIT_SLOT = Symbol.for('@agora/diagnostics:emit');
type EmitFn = (
  lib: string,
  event: string,
  payload: unknown,
  options?: { app?: string; durationMs?: number },
) => void;

/** Every event crypto publishes on `agora:crypto:<event>`. */
export const CRYPTO_DIAGNOSTIC_EVENTS = [
  'encrypt',
  'decrypt',
  'rewrap',
  'datakey',
  'sign',
  'verify',
  'hmac',
  'keys.create',
  'keys.rotate',
  'keys.policy',
  'keys.delete',
  'keys.export',
  'denied',
  'subjects.forget',
  'subjects.cache',
] as const;

export type CryptoDiagnosticEvent = (typeof CRYPTO_DIAGNOSTIC_EVENTS)[number];

/** The events of one operation on a key (everything but `denied` and the `subjects.*` ones). */
export type CryptoOperationEvent = Exclude<
  CryptoDiagnosticEvent,
  'denied' | 'subjects.forget' | 'subjects.cache'
>;

/** One operation the service ran (or failed to run) on a key. */
export interface CryptoOperationPayload {
  /** The partition the operation acted on (also the envelope's `app`). */
  app: string;
  key: string;
  /** The key version used, when the operation succeeded on one. */
  version?: number;
  outcome: 'ok' | 'error';
  /** The wire error code (`not_found`, `invalid`, …) when `outcome` is `error`; never the message. */
  errorCode?: string;
  /** Who asked: the token's actor, `app:<partition>`, `cli:<user>`, a console operator. */
  actor: string;
  clientId?: string;
  durationMs: number;
  /** Size of the input or output the operation handled (plaintext or message), in bytes. */
  bytes?: number;
}

/** A call refused for a missing capability. */
export interface CryptoDeniedPayload {
  app: string;
  /** The event the call would have been (`encrypt`, `keys.delete`, …). */
  op: CryptoOperationEvent;
  key?: string;
  /** The capability the token lacked. */
  capability: string;
  errorCode: 'forbidden';
  actor: string;
  clientId?: string;
}

/** The local half of crypto-shredding: the subject key deleted and its wrapped data keys dropped. */
export interface CryptoSubjectForgetPayload {
  app?: string;
  /** The subject's key name. */
  key: string;
  outcome: 'ok' | 'error';
  errorCode?: string;
  /** Wrapped data keys removed from this app's database. */
  dataKeys?: number;
  durationMs: number;
}

/** A subject data-key lookup: served from this process' cache, or unwrapped by the control plane. */
export interface CryptoSubjectCachePayload {
  app?: string;
  key: string;
  op: 'encrypt' | 'decrypt';
  outcome: 'hit' | 'miss';
}

export type CryptoDiagnosticPayloads = {
  [E in CryptoOperationEvent]: CryptoOperationPayload;
} & {
  denied: CryptoDeniedPayload;
  'subjects.forget': CryptoSubjectForgetPayload;
  'subjects.cache': CryptoSubjectCachePayload;
};

/** The audit operation → its event. Reads (`read`, `public-key`) publish nothing. */
const OPERATION_EVENTS: Record<string, CryptoOperationEvent> = {
  encrypt: 'encrypt',
  decrypt: 'decrypt',
  rewrap: 'rewrap',
  datakey: 'datakey',
  sign: 'sign',
  verify: 'verify',
  hmac: 'hmac',
  create: 'keys.create',
  rotate: 'keys.rotate',
  policy: 'keys.policy',
  delete: 'keys.delete',
  export: 'keys.export',
};

/** The event an audit operation publishes, or `undefined` for a read. */
export function cryptoEventFor(operation: string): CryptoOperationEvent | undefined {
  return OPERATION_EVENTS[operation];
}

/** Partition names diagnostics accepts as an envelope `app`. */
const APP = /^[A-Za-z0-9_.-]{1,64}$/;

/** Events already passed through `emit` once (that call registers the channel with diagnostics). */
const registered = new Set<CryptoDiagnosticEvent>();
const channels = new Map(
  CRYPTO_DIAGNOSTIC_EVENTS.map((event) => [event, channel(`agora:crypto:${event}`)]),
);

/**
 * Publishes one `agora:crypto:<event>`. The payload is a thunk, built only when someone listens
 * (after the first call per event, which registers the channel). `app` is stamped on the envelope.
 * Never throws: observability must not break an operation.
 */
export function emitCrypto<E extends CryptoDiagnosticEvent>(
  event: E,
  payload: () => CryptoDiagnosticPayloads[E],
  options: { app?: string | undefined; durationMs?: number | undefined } = {},
): void {
  try {
    if (registered.has(event) && !channels.get(event)?.hasSubscribers) return;
    const emit = (globalThis as Record<symbol, unknown>)[EMIT_SLOT];
    if (typeof emit !== 'function') return;
    registered.add(event);
    const app = options.app !== undefined && APP.test(options.app) ? options.app : undefined;
    const emitOptions = {
      ...(app !== undefined ? { app } : {}),
      ...(options.durationMs !== undefined ? { durationMs: options.durationMs } : {}),
    };
    (emit as EmitFn)('crypto', event, payload(), emitOptions);
  } catch {
    // A broken diagnostics subscriber must never take a crypto operation down with it.
  }
}

/** The wire code of a failure (`CryptoError`, `SubjectKeyError`, client errors), never its message. */
export function errorCodeOf(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && /^[a-z_]{1,32}$/.test(code) ? code : 'internal';
}
