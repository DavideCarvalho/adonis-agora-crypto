/**
 * The wire contract of a tenant ↔ control-plane **transport** for crypto's *call* channel: the
 * tenant asks for one operation, the control plane verifies the token, runs it and answers.
 *
 * HTTP is the default and needs none of this file; the other drivers (Redis, queue, BullMQ,
 * durable) carry the same envelope so the security rules are identical everywhere: the token
 * travels on every message, the partition comes only from the verified token, and the message id
 * is the dedupe key.
 */
import { CryptoError, type CryptoErrorCode, statusForErrorCode } from './index.js';

export const TRANSPORT_MESSAGE_VERSION = 1;

/** Operations the call channel serves. Same names in the HTTP wire and in every driver. */
export const TRANSPORT_OPERATIONS = [
  'encrypt',
  'decrypt',
  'rewrap',
  'datakeys',
  'sign',
  'verify',
  'hmac',
  'keys.list',
  'keys.get',
  'keys.create',
  'keys.rotate',
  'keys.policy',
  'keys.delete',
  'keys.export',
  'keys.public',
  'audit',
  'overview',
  'whoami',
] as const;
export type TransportOperation = (typeof TRANSPORT_OPERATIONS)[number];

/** Default cap for one message (UTF-8 bytes). A crypto op is small; a bigger one is a bug. */
export const MAX_TRANSPORT_MESSAGE_BYTES = 512 * 1024;

/** What the tenant publishes. */
export interface TransportCallMessage {
  v: typeof TRANSPORT_MESSAGE_VERSION;
  /** Dedupe key, unique per attempt-set (`<partition>:<id>` on the server). */
  id: string;
  operation: TransportOperation;
  input: unknown;
  /** The tenant token. The server runs `verifyTenant` on every message with it. */
  token: string;
  /** Epoch ms, for a freshness window and for the audit trail of the broker hop. */
  issuedAt: number;
}

/** What the control plane answers. */
export interface TransportReplyMessage {
  v: typeof TRANSPORT_MESSAGE_VERSION;
  id: string;
  ok: boolean;
  result?: unknown;
  error?: { code: CryptoErrorCode; message: string };
}

export interface TransportCall {
  operation: TransportOperation;
  input: unknown;
  token: string;
  /** Overrides the driver's default. */
  timeoutMs?: number;
  /** Overrides the generated id (tests, retries that keep the same id). */
  id?: string;
}

/** How a tenant reaches the control plane on a driver. */
export interface CryptoTransport {
  readonly name: string;
  call<T = unknown>(call: TransportCall): Promise<T>;
}

export type TransportErrorCode = 'timeout' | 'too_large' | 'rejected' | 'unavailable' | 'malformed';

export class TransportError extends Error {
  readonly code: TransportErrorCode;
  constructor(code: TransportErrorCode, message: string) {
    super(`crypto transport: ${message}`);
    this.name = 'TransportError';
    this.code = code;
  }
}

export const newTransportMessageId = (): string => globalThis.crypto.randomUUID();

const utf8Length = (value: string): number => Buffer.byteLength(value, 'utf8');

/** Refuses a message over the cap before it reaches a broker, with a clear error. */
export function assertTransportSize(value: unknown, max = MAX_TRANSPORT_MESSAGE_BYTES): void {
  let size: number;
  try {
    size = utf8Length(JSON.stringify(value) ?? '');
  } catch {
    throw new TransportError('malformed', 'the message is not JSON');
  }
  if (size > max) {
    throw new TransportError('too_large', `the message is ${size} bytes (max ${max})`);
  }
}

/** The server's dedupe key: a shared broker is not a trust boundary, so the partition is bound in. */
export const transportDedupeKey = (partition: string, id: string): string => `${partition}:${id}`;

export interface DedupeStore {
  /** `true` the first time, `false` for a repeat within the window. */
  seen(key: string): boolean;
  clear(): void;
}

/**
 * In-process dedupe with a TTL and a hard cap (the oldest keys are dropped first). A broker
 * delivers at-least-once; the same id must never run an operation twice. Multi-replica control
 * planes need a shared store instead (documented).
 */
export function createDedupe(
  options: { ttlMs?: number; max?: number; now?: () => number } = {},
): DedupeStore {
  const ttlMs = options.ttlMs ?? 10 * 60 * 1000;
  const max = options.max ?? 10_000;
  const now = options.now ?? Date.now;
  const entries = new Map<string, number>();
  return {
    seen(key) {
      const at = now();
      for (const [existing, expiresAt] of entries) {
        if (expiresAt > at) break;
        entries.delete(existing);
      }
      if (entries.has(key)) return false;
      entries.set(key, at + ttlMs);
      while (entries.size > max) {
        const oldest = entries.keys().next();
        if (oldest.done) break;
        entries.delete(oldest.value);
      }
      return true;
    },
    clear() {
      entries.clear();
    },
  };
}

/** A reply is an error when the control plane said so, or when it never came. */
export function replyError(reply: TransportReplyMessage): CryptoError {
  const code = reply.error?.code ?? 'unreadable';
  return new CryptoError(code, reply.error?.message ?? `crypto: ${code}`);
}

/** Maps an operation name to the HTTP call the typed client makes (used by the http driver). */
export const TRANSPORT_HTTP_PATHS: Record<TransportOperation, string> = {
  encrypt: '/v1/encrypt',
  decrypt: '/v1/decrypt',
  rewrap: '/v1/rewrap',
  datakeys: '/v1/datakeys',
  sign: '/v1/sign',
  verify: '/v1/verify',
  hmac: '/v1/hmac',
  'keys.list': '/v1/keys',
  'keys.get': '/v1/keys',
  'keys.create': '/v1/keys',
  'keys.rotate': '/v1/keys',
  'keys.policy': '/v1/keys',
  'keys.delete': '/v1/keys',
  'keys.export': '/v1/keys',
  'keys.public': '/v1/keys',
  audit: '/v1/audit',
  overview: '/v1/audit',
  whoami: '/v1/whoami',
};

export { statusForErrorCode };
