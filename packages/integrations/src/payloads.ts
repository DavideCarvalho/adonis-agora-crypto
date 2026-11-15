import { type CipherSource, cipherFor } from './source.js';

/** The field that marks a sealed payload, so a mixed fleet can tell it from a plain value. */
export const SEALED_FIELD = 'agoraSealed';

export interface SealedValue {
  [SEALED_FIELD]: string;
}

export interface SealedPayloadsOptions {
  source: CipherSource;
  /** The key that seals the payloads (per hop, e.g. `durable-tasks`). */
  key: string;
  /** Extra context bound into the AAD (a direction, a queue family). */
  aad?: string;
  /** Refuse a plain value instead of passing it through. Default `false` (rollout friendly). */
  strict?: boolean;
  actor?: string;
}

export interface SealedPayloads {
  seal(value: unknown): Promise<SealedValue>;
  open<T = unknown>(value: unknown): Promise<T>;
  isSealed(value: unknown): value is SealedValue;
}

const isSealed = (value: unknown): value is SealedValue =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as Record<string, unknown>)[SEALED_FIELD] === 'string';

/**
 * Payload sealing with **no freshness window**: a queued task may sit for hours, so `iat` would
 * only produce false refusals. Confidentiality and integrity come from AES-GCM; replay protection
 * stays where the queue already has it (ids, dedupe, queue semantics) — the ids stay in clear.
 */
export function sealedPayloads(options: SealedPayloadsOptions): SealedPayloads {
  const cipher = cipherFor(options.source, options.actor ?? 'payloads');
  const aad = `agora:payload:v1:${options.aad ?? ''}`;
  return {
    isSealed,
    async seal(value) {
      const { ciphertext } = await cipher.encrypt({
        key: options.key,
        plaintext: JSON.stringify(value ?? null),
        aad,
      });
      return { [SEALED_FIELD]: ciphertext };
    },
    async open<T = unknown>(value: unknown): Promise<T> {
      if (!isSealed(value)) {
        if (options.strict === true) {
          throw new Error(
            'crypto: expected a sealed payload; is the other side of this hop also encrypted?',
          );
        }
        return value as T;
      }
      const { plaintext } = await cipher.decrypt({
        key: options.key,
        ciphertext: value[SEALED_FIELD],
        aad,
      });
      return JSON.parse(plaintext) as T;
    },
  };
}
