import {
  type CryptoTransport,
  newTransportMessageId,
  type TransportCall,
  type TransportCallMessage,
  TransportError,
  type TransportReplyMessage,
} from '@adonis-agora/crypto-core';
import type { CryptoRpc } from './rpc.js';

/**
 * A broker that can carry a request and its reply. Every non-HTTP driver implements this: the
 * envelope, the token, the dedupe and the limits are the same, only the substrate changes.
 */
export interface BrokerDriver {
  readonly name: string;
  /** Publishes the request and waits for its reply (`timeoutMs` must be honoured). */
  request(message: TransportCallMessage, timeoutMs: number): Promise<TransportReplyMessage>;
  /** Consumes requests until the returned stop function is called. */
  serve(
    handler: (message: unknown) => Promise<TransportReplyMessage | null>,
    options?: { deadLetter?: (message: unknown, reason: string) => Promise<void> },
  ): Promise<() => Promise<void>>;
}

/** A `CryptoTransport` over any broker. */
export function brokerTransport(driver: BrokerDriver, timeoutMs = 10_000): CryptoTransport {
  return {
    name: driver.name,
    async call<T = unknown>(call: TransportCall): Promise<T> {
      const message: TransportCallMessage = {
        v: 1,
        id: call.id ?? newTransportMessageId(),
        operation: call.operation,
        input: call.input,
        token: call.token,
        issuedAt: Date.now(),
      };
      const reply = await driver.request(message, call.timeoutMs ?? timeoutMs);
      if (reply.id !== message.id || reply.v !== 1) {
        throw new TransportError('rejected', 'the reply does not match the request');
      }
      if (!reply.ok) {
        throw new TransportError(
          reply.error?.code === 'unauthenticated' ? 'rejected' : 'unavailable',
          reply.error?.message ?? 'the control plane refused the call',
        );
      }
      return reply.result as T;
    },
  };
}

/** Whether a configured value is a broker driver (it can `request`/`serve`) rather than a transport. */
export function isBrokerDriver(value: CryptoTransport | BrokerDriver): value is BrokerDriver {
  const candidate = value as Partial<BrokerDriver>;
  return typeof candidate.request === 'function' && typeof candidate.serve === 'function';
}

/**
 * Accepts what `transports.*` hands back on a tenant: the HTTP driver is already a `CryptoTransport`,
 * every other driver is a broker and gets the shared envelope adapter. `tenant.transport` takes either,
 * so `transport: transports.redis({ connection })` and `transport: transports.http({ url })` both work.
 */
export function asCryptoTransport(value: CryptoTransport | BrokerDriver): CryptoTransport {
  return isBrokerDriver(value) ? brokerTransport(value) : value;
}

/**
 * Runs the control plane side of a broker: verify, dedupe, run, answer; poison messages go to the
 * driver's dead-letter instead of being retried forever.
 */
export async function serveBroker(
  driver: BrokerDriver,
  rpc: CryptoRpc,
  options: { deadLetter?: (message: unknown, reason: string) => Promise<void> } = {},
): Promise<() => Promise<void>> {
  return driver.serve(async (message) => {
    if (rpc.isPoison(message)) {
      await options.deadLetter?.(message, 'poison');
      // `null` means "do not reply": nothing could open it anyway.
      return null;
    }
    const reply = await rpc.handle(message);
    return reply.id === '' ? null : reply;
  }, options);
}
