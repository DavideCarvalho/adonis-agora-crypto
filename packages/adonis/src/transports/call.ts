import type { TransportReplyMessage } from '@adonis-agora/crypto-core';
import type { CryptoRuntime } from '../runtime.js';
import { getRuntime } from '../services/accessor.js';
import { type CryptoRpc, createCryptoRpc } from './rpc.js';

/** One RPC per booted runtime, so the dedupe window survives across calls. */
const rpcs = new WeakMap<CryptoRuntime, CryptoRpc>();

export interface HandleTransportCallOptions {
  /** Reuse an RPC built elsewhere (tests, or an API instance's own). */
  rpc?: CryptoRpc;
  /** The runtime to use. Default: the booted provider's. */
  runtime?: CryptoRuntime;
}

/**
 * Runs one call envelope **in process on a crypto server** — the body of the `crypto.call` durable
 * workflow, and of any other out-of-band channel (a serverless function, a cron, a CLI).
 *
 * It is the same handler as `POST /_crypto/v1/transport` and `serveBroker`: it verifies the tenant
 * token, derives the partition from the token (never from the envelope), enforces the message size
 * and age, dedupes by message id and dispatches to the local service.
 *
 * ```ts title="app/workflows/crypto_call_workflow.ts"
 * import { BaseWorkflow, type WorkflowCtx } from '@adonis-agora/durable'
 * import { handleTransportCall } from '@adonis-agora/crypto'
 *
 * export default class CryptoCallWorkflow extends BaseWorkflow {
 *   static workflow = { name: 'crypto.call', version: '1' }
 *
 *   async run(ctx: WorkflowCtx, input: unknown) {
 *     return ctx.localStep('crypto.call', () => handleTransportCall(input))
 *   }
 * }
 * ```
 *
 * `localStep` is what makes it replay-safe: the operation runs once per run and a replay returns
 * the checkpointed reply instead of re-running it (the envelope id is the second guard).
 */
export function handleTransportCall(
  message: unknown,
  options: HandleTransportCallOptions = {},
): Promise<TransportReplyMessage> {
  if (options.rpc) return options.rpc.handle(message);
  const runtime = options.runtime ?? getRuntime();
  if (!runtime.service || !runtime.verifyTenant) {
    throw new Error(
      runtime.topology === 'tenant'
        ? '@adonis-agora/crypto: handleTransportCall() runs on a server (standalone or control-plane), not on a tenant'
        : '@adonis-agora/crypto: handleTransportCall() needs `verifyTenant` — configure crypto.verifyTenant on the control plane',
    );
  }
  let rpc = rpcs.get(runtime);
  if (!rpc) {
    rpc = createCryptoRpc({ service: runtime.service, verifyTenant: runtime.verifyTenant });
    rpcs.set(runtime, rpc);
  }
  return rpc.handle(message);
}
