import {
  type TransportCallMessage,
  TransportError,
  type TransportReplyMessage,
} from '@adonis-agora/crypto-core';
import type { BrokerDriver } from './broker.js';

/** What a durable run settles with (`RunResult`, structurally). */
export interface DurableRunResult {
  /** `completed`, `failed`, `cancelled`, `dead`, … */
  status: string;
  output?: unknown;
  error?: unknown;
}

/**
 * The durable engine, as a transport sees it: `engine.start(workflow, input, runId)` runs the
 * workflow and resolves with its result — the reply, on the same line.
 */
export interface DurableEngineLike {
  start(workflow: string, input: unknown, runId: string): Promise<DurableRunResult>;
}

/**
 * The store-less durable **run gateway** a `role: 'tenant'` pod binds
 * (`@adonis-agora/durable:run-gateway`): `gateway.start(workflow, input, { runId })` round-trips the
 * run to the control plane and resolves with its result, exactly like the engine.
 */
export interface DurableGatewayLike {
  start(workflow: string, input: unknown, opts?: { runId?: string }): Promise<DurableRunResult>;
}

/** A starter, or a lazily resolved one (`() => app.container.make(...)`, the config-file friendly form). */
export type DurableStarter<T> = T | (() => T | Promise<T>);

export interface DurableTransportOptions {
  /** The engine (standalone/control-plane roles). One of `engine`/`gateway` is required. */
  engine?: DurableStarter<DurableEngineLike>;
  /** The store-less run gateway (a `role: 'tenant'` durable pod). One of `engine`/`gateway` is required. */
  gateway?: DurableStarter<DurableGatewayLike>;
  /** The workflow the server registers. Default `crypto.call`. */
  workflow?: string;
  /** How long `call` waits for the run. Default 15s — a workflow turn, not a queue hop. */
  timeoutMs?: number;
}

type Starter = (workflow: string, input: unknown, runId: string) => Promise<DurableRunResult>;

const isGetter = (value: unknown): value is () => unknown => typeof value === 'function';

/**
 * `transports.durable({ engine })` (or `{ gateway }` on a store-less tenant pod) — the call channel
 * as a durable workflow.
 *
 * The tenant starts `crypto.call` with the envelope as its input, and durable resolves the start with
 * the run's result: the reply comes back on the same line, no reply queue and no polling. The server
 * side is one file under `app/workflows/` whose body is `handleTransportCall(input)` — the same
 * verify → dedupe → run path as `POST /_crypto/v1/transport` and the broker drivers.
 *
 * A run that fails surfaces its error; a run that never settles is a `TransportError('timeout')`.
 * It is the slowest driver (a workflow turn), which is why the timeout defaults higher than the rest.
 */
export function durableTransport(options: DurableTransportOptions): BrokerDriver {
  const workflow = options.workflow ?? 'crypto.call';
  const timeoutMs = options.timeoutMs ?? 15_000;
  if (options.engine === undefined && options.gateway === undefined) {
    throw new TypeError(
      'crypto: transports.durable needs an `engine` (standalone/control-plane) or a `gateway` (tenant pod)',
    );
  }
  if (options.engine !== undefined && options.gateway !== undefined) {
    throw new TypeError('crypto: transports.durable takes `engine` or `gateway`, not both');
  }

  let starter: Starter | undefined;
  const resolve = async (): Promise<Starter> => {
    if (starter) return starter;
    if (options.engine !== undefined) {
      const engine = isGetter(options.engine)
        ? await (options.engine as () => DurableEngineLike | Promise<DurableEngineLike>)()
        : options.engine;
      starter = (name, input, runId) => engine.start(name, input, runId);
    } else {
      const gateway = isGetter(options.gateway)
        ? await (options.gateway as () => DurableGatewayLike | Promise<DurableGatewayLike>)()
        : options.gateway!;
      starter = (name, input, runId) => gateway.start(name, input, { runId });
    }
    return starter;
  };

  return {
    name: 'durable',
    async request(message: TransportCallMessage, timeout: number): Promise<TransportReplyMessage> {
      const budget = timeout > 0 ? timeout : timeoutMs;
      const start = await resolve();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timedOut = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new TransportError('timeout', `no reply within ${budget}ms`)),
          budget,
        );
        // Do not hold the process open for a call that already gave up.
        timer.unref?.();
      });
      try {
        const run = await Promise.race([start(workflow, message, message.id), timedOut]);
        if (run.status !== 'completed') {
          throw new TransportError(
            'unavailable',
            `the ${workflow} run is ${run.status}: ${String(run.error ?? 'no output')}`,
          );
        }
        const reply = run.output;
        if (typeof reply !== 'object' || reply === null) {
          throw new TransportError('malformed', `the ${workflow} run finished without a reply`);
        }
        return reply as TransportReplyMessage;
      } finally {
        if (timer) clearTimeout(timer);
      }
    },

    /**
     * Nothing to consume: the durable engine runs the workflow. The server registers
     * `cryptoCallWorkflow` in `app/workflows/`, which the engine starts.
     */
    async serve() {
      return async () => {};
    },
  };
}
