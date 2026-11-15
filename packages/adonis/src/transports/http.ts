import {
  type CryptoTransport,
  newTransportMessageId,
  TRANSPORT_MESSAGE_VERSION,
  type TransportCall,
  type TransportCallMessage,
  TransportError,
} from '@adonis-agora/crypto-core';

/** The default driver: the tenant API over HTTP, exactly as before. */
export interface HttpTransportOptions {
  /** The control plane's base URL, including the prefix (`https://crypto.example.com/_crypto`). */
  url: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/**
 * `transports.http({ url })` — one `POST /_crypto/v1/transport` per call, with the same envelope
 * the other drivers carry (`id`, `operation`, `input`, `token`), so switching drivers does not
 * change the security story. The plain per-operation endpoints stay for non-JS clients.
 */
export function httpTransport(options: HttpTransportOptions): CryptoTransport {
  if (!/^https?:\/\//.test(options.url)) {
    throw new Error('crypto: transports.http needs an absolute http(s) url');
  }
  const base = options.url.replace(/\/$/, '');
  const timeoutMs = options.timeoutMs ?? 10_000;
  const inner = options.fetch ?? fetch;

  return {
    name: 'http',
    async call<T = unknown>(call: TransportCall): Promise<T> {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), call.timeoutMs ?? timeoutMs);
      const message: TransportCallMessage = {
        v: TRANSPORT_MESSAGE_VERSION,
        id: call.id ?? newTransportMessageId(),
        operation: call.operation,
        input: call.input,
        token: call.token,
        issuedAt: Date.now(),
      };
      try {
        const response = await inner(`${base}/v1/transport`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify(message),
          signal: controller.signal,
        });
        const body = (await response.json().catch(() => ({}))) as {
          ok?: boolean;
          result?: unknown;
          error?: { code?: string; message?: string };
        };
        if (!response.ok || body.ok !== true) {
          throw new TransportError(
            response.status === 401 ? 'rejected' : 'unavailable',
            body.error?.message ?? `the control plane answered ${response.status}`,
          );
        }
        return body.result as T;
      } catch (error) {
        if (error instanceof TransportError) throw error;
        if ((error as { name?: string }).name === 'AbortError') {
          throw new TransportError('timeout', 'the call timed out');
        }
        throw new TransportError('unavailable', (error as Error).message);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
