import {
  type CryptoTransport,
  newTransportMessageId,
  ServerUrl,
  type ServerUrlSource,
  TRANSPORT_MESSAGE_VERSION,
  type TransportCall,
  type TransportCallMessage,
  TransportError,
} from '@adonis-agora/crypto-core';

/** The default driver: the tenant API over HTTP, exactly as before. */
export interface HttpTransportOptions {
  /**
   * The control plane's base URL, including the prefix (`https://crypto.example.com/_crypto`), or a
   * function that resolves it before the first call (`controlPlaneUrl(...)` from
   * `@adonis-agora/authkit-client`). A function is looked up again after a connection error or a 404.
   */
  url: ServerUrlSource;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/**
 * `transports.http({ url })` — one `POST /_crypto/v1/transport` per call, with the same envelope
 * the other drivers carry (`id`, `operation`, `input`, `token`), so switching drivers does not
 * change the security story. The plain per-operation endpoints stay for non-JS clients.
 */
export function httpTransport(options: HttpTransportOptions): CryptoTransport {
  if (typeof options.url !== 'function' && !/^https?:\/\//.test(String(options.url))) {
    throw new Error('crypto: transports.http needs an absolute http(s) url');
  }
  const url = new ServerUrl(options.url);
  const timeoutMs = options.timeoutMs ?? 10_000;
  const inner = options.fetch ?? fetch;
  /** Failures that say the control plane is not where the URL points (worth a URL refresh). */
  const moved = new WeakSet<TransportError>();
  const unreachable = (code: 'unavailable' | 'timeout', message: string) => {
    const failure = new TransportError(code, message);
    moved.add(failure);
    return failure;
  };

  const send = async <T>(call: TransportCall): Promise<T> => {
    let base: string;
    try {
      base = await url.resolve();
    } catch (error) {
      throw unreachable(
        'unavailable',
        `could not resolve the control plane url: ${(error as Error).message}`,
      );
    }
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
        const text = body.error?.message ?? `the control plane answered ${response.status}`;
        // A 404 without the transport's own error body: no transport route on that host.
        if (response.status === 404 && body.error === undefined) {
          throw unreachable('unavailable', text);
        }
        throw new TransportError(response.status === 401 ? 'rejected' : 'unavailable', text);
      }
      return body.result as T;
    } catch (error) {
      if (error instanceof TransportError) throw error;
      if ((error as { name?: string }).name === 'AbortError') {
        throw new TransportError('timeout', 'the call timed out');
      }
      throw unreachable('unavailable', (error as Error).message);
    } finally {
      clearTimeout(timer);
    }
  };

  return {
    name: 'http',
    async call<T = unknown>(call: TransportCall): Promise<T> {
      try {
        return await send<T>(call);
      } catch (error) {
        // The control plane moved: look a lazy URL up again and, when it changed, try once more.
        if (!(error instanceof TransportError) || !moved.has(error) || !url.lazy) throw error;
        const before = url.current;
        const after = await url.refresh();
        if (after === undefined || after === before) throw error;
        return send<T>(call);
      }
    },
  };
}
