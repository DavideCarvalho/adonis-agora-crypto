/**
 * Why a subject-key operation failed.
 *
 * - `unavailable`: the control plane could not be reached (network, timeout, 429, 502/503/504) and
 *   the data key was not in the cache. Retry later; nothing was read or written.
 * - `forgotten`: the subject's key was deleted (`forgetSubject`), so its data is gone for good.
 * - `invalid`: the value is not a subject ciphertext, was tampered with, was moved to another row or
 *   column, belongs to another subject, or a model is misconfigured.
 * - `denied`: the control plane refused the token (missing capability, bad credentials).
 * - `sealed`: a model attribute still holds ciphertext (it was loaded without the model hooks, e.g.
 *   `.pojo()` or raw SQL) and was read as if it were data.
 * - `failed`: anything else the control plane reported.
 */
export type SubjectKeyErrorCode =
  | 'unavailable'
  | 'forgotten'
  | 'invalid'
  | 'denied'
  | 'sealed'
  | 'failed';

/** The one error type subject keys and encrypted columns throw. Never carries plaintext. */
export class SubjectKeyError extends Error {
  readonly code: SubjectKeyErrorCode;

  constructor(code: SubjectKeyErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'SubjectKeyError';
    this.code = code;
  }
}

const UNAVAILABLE_STATUS = new Set([0, 429, 502, 503, 504]);

/**
 * Translates what the operations threw (a `CryptoError` in process, a `CryptoClientError` over HTTP,
 * a `TransportError` over a broker) into a {@link SubjectKeyError}. Only failures that mean "the
 * control plane is not there" become `unavailable`.
 */
export function fromControlPlane(error: unknown, what: string): SubjectKeyError {
  if (error instanceof SubjectKeyError) return error;
  const failure = error as { name?: unknown; code?: unknown; status?: unknown; message?: unknown };
  const code = typeof failure?.code === 'string' ? failure.code : undefined;
  const status = typeof failure?.status === 'number' ? failure.status : undefined;
  const message = typeof failure?.message === 'string' ? failure.message : String(error);
  const name = typeof failure?.name === 'string' ? failure.name : '';
  if (
    code === 'network' ||
    code === 'timeout' ||
    (name === 'TransportError' && (code === 'unavailable' || code === 'timeout')) ||
    (name === 'CryptoClientError' && status !== undefined && UNAVAILABLE_STATUS.has(status))
  ) {
    return new SubjectKeyError(
      'unavailable',
      `crypto: ${what}: the control plane is unavailable (${message})`,
      { cause: error },
    );
  }
  if (code === 'deleted') {
    return new SubjectKeyError('forgotten', `crypto: ${what}: the subject was forgotten`, {
      cause: error,
    });
  }
  if (code === 'forbidden' || code === 'unauthenticated') {
    return new SubjectKeyError('denied', `crypto: ${what}: ${message}`, { cause: error });
  }
  if (code === 'invalid') {
    return new SubjectKeyError('invalid', `crypto: ${what}: ${message}`, { cause: error });
  }
  return new SubjectKeyError('failed', `crypto: ${what}: ${message}`, { cause: error });
}
