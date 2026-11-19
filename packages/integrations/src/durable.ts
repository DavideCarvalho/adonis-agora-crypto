import { sealedPayloads } from './payloads.js';
import type { CipherSource } from './source.js';
import { cryptoServerUse, STACK_DESCRIPTOR, withUse } from './stack.js';

/**
 * The parts of durable's `Transport`/`ControlPlane` these decorators understand, declared
 * structurally: `@adonis-agora/durable` stays an optional peer and nothing is imported at runtime.
 */
export interface TransportLike {
  dispatch(task: { input?: unknown } & Record<string, unknown>): Promise<void>;
  onResult(
    handler: (
      result: { output?: unknown; error?: unknown } & Record<string, unknown>,
    ) => Promise<void>,
  ): void;
  onHeartbeat?(
    handler: (beat: { progress?: unknown } & Record<string, unknown>) => Promise<void>,
  ): void;
}

export interface ControlPlaneLike {
  publishControl(
    message: { kind: string; event?: unknown } & Record<string, unknown>,
  ): Promise<void>;
  onControl(
    handler: (message: { kind: string; event?: unknown } & Record<string, unknown>) => void,
  ): void;
}

export interface DurableEncryptionOptions {
  source: CipherSource;
  /** The key that seals the payloads (e.g. `durable-tasks`). */
  key: string;
  /** Extra context bound into the AAD, e.g. `tasks` for the transport and `control` for the plane. */
  aad?: string;
  /** Refuse a plain payload instead of passing it through. Default `false` (rollout friendly). */
  strict?: boolean;
}

/**
 * Encrypts a durable **transport**'s payloads and leaves routing metadata in clear:
 *
 * - `dispatch`: `task.input` is sealed; `runId`, `seq`, `stepId`, `name`, `group`, `priority`,
 *   `attempt`, `traceparent` and the dedupe keys stay readable, so queues route and dedupe exactly
 *   as before;
 * - `onResult`: `result.output` (and a step error) is opened; status and ids stay clear;
 * - `onHeartbeat`: `beat.progress` is sealed/opened; liveness ids stay clear.
 *
 * ```ts title="config/durable.ts"
 * transport: encryptedTransport(transports.redis({ connection: 'main' }), {
 *   source: { client: crypto },
 *   key: 'durable-tasks',
 * })
 * ```
 *
 * The decorator wraps an already-built instance (durable accepts one), so the app keeps whatever
 * transport it had and the crypto server owns the payload key.
 */
export function encryptedTransport<T extends TransportLike>(
  inner: T,
  options: DurableEncryptionOptions,
): T {
  const payloads = sealedPayloads({
    source: options.source,
    key: options.key,
    aad: options.aad ?? 'durable:transport',
    ...(options.strict !== undefined ? { strict: options.strict } : {}),
    actor: 'durable:transport',
  });

  return new Proxy(inner, {
    get(target, property) {
      // Telescope: what the wrapped transport uses, plus the crypto server for its payloads.
      if (property === STACK_DESCRIPTOR) {
        return withUse(Reflect.get(target, property, target), cryptoServerUse('durable payloads'));
      }
      if (property === 'dispatch') {
        return async (task: { input?: unknown } & Record<string, unknown>) => {
          const sealed = { ...task, input: await payloads.seal(task.input) };
          return target.dispatch(sealed);
        };
      }
      if (property === 'onResult') {
        return (
          handler: (
            result: { output?: unknown; error?: unknown } & Record<string, unknown>,
          ) => Promise<void>,
        ) =>
          target.onResult(async (result) => {
            handler({
              ...result,
              ...(result.output !== undefined
                ? { output: await payloads.open(result.output) }
                : {}),
              ...(result.error !== undefined ? { error: await payloads.open(result.error) } : {}),
            });
          });
      }
      if (property === 'onHeartbeat' && typeof target.onHeartbeat === 'function') {
        return (
          handler: (beat: { progress?: unknown } & Record<string, unknown>) => Promise<void>,
        ) =>
          target.onHeartbeat!(async (beat) => {
            handler({
              ...beat,
              ...(beat.progress !== undefined
                ? { progress: await payloads.open(beat.progress) }
                : {}),
            });
          });
      }
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/**
 * Encrypts a durable **control plane**'s event payloads: a `{ kind: 'event', event }` message
 * carries a sealed `event`; `cancel`, `enqueued` and `schedulePause` messages are routing only and
 * travel in clear, as do `kind`, `runId`, `from` and the schedule key.
 *
 * ```ts title="config/durable.ts"
 * controlPlane: encryptedControlPlane(new RedisControlPlane({ connection: 'main' }), {
 *   source: { client: crypto },
 *   key: 'durable-tasks',
 * })
 * ```
 *
 * **Interop:** an encrypted channel is not readable by a plain consumer. A NestJS fleet (or any
 * service without this decorator) on the same Redis channel sees sealed events it cannot open, so
 * both sides must be upgraded together, or the encrypted plane must run on its own channel.
 */
export function encryptedControlPlane<T extends ControlPlaneLike>(
  inner: T,
  options: DurableEncryptionOptions,
): T {
  const payloads = sealedPayloads({
    source: options.source,
    key: options.key,
    aad: options.aad ?? 'durable:control',
    ...(options.strict !== undefined ? { strict: options.strict } : {}),
    actor: 'durable:control',
  });

  return new Proxy(inner, {
    get(target, property) {
      if (property === STACK_DESCRIPTOR) {
        return withUse(Reflect.get(target, property, target), cryptoServerUse('durable events'));
      }
      if (property === 'publishControl') {
        return async (message: { kind: string; event?: unknown } & Record<string, unknown>) => {
          const outgoing =
            message.kind === 'event' && message.event !== undefined
              ? { ...message, event: await payloads.seal(message.event) }
              : message;
          return target.publishControl(outgoing);
        };
      }
      if (property === 'onControl') {
        return (
          handler: (message: { kind: string; event?: unknown } & Record<string, unknown>) => void,
        ) => {
          // `onControl` is synchronous and decryption is not: a serialized chain keeps the order the
          // broker delivered (a `completed` can never overtake the `started` before it).
          let chain: Promise<void> = Promise.resolve();
          target.onControl((message) => {
            // Every message goes through the chain, encrypted or not: an `enqueued` that arrives
            // after a `completed` must not overtake it just because it needed no decryption.
            chain = chain.then(async () => {
              if (message.kind !== 'event' || message.event === undefined) {
                handler(message);
                return;
              }
              handler({ ...message, event: await payloads.open(message.event) });
            });
            chain = chain.catch((error: unknown) => {
              // Dropping an event silently would leave a run unobserved; fail loudly instead.
              console.error(
                '[@adonis-agora/crypto-integrations] a control event did not open',
                error,
              );
            });
          });
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
