import {
  TRANSPORT_MESSAGE_VERSION,
  type TransportCallMessage,
  TransportError,
} from '@adonis-agora/crypto-core';
import { describe, expect, it } from 'vitest';
import { localOperations } from '../../src/operations.js';
import type { CryptoRuntime } from '../../src/runtime.js';
import { memoryCrypto } from '../../src/testing/index.js';
import { handleTransportCall } from '../../src/transports/call.js';
import {
  type DurableEngineLike,
  type DurableGatewayLike,
  durableTransport,
} from '../../src/transports/durable.js';

const TENANT_TOKEN = 'tenant-token';

function controlPlane() {
  const crypto = memoryCrypto();
  const runtime: CryptoRuntime = {
    topology: 'control-plane',
    partition: '',
    service: crypto.service,
    verifyTenant: async (request) =>
      request.token === TENANT_TOKEN ? { partition: 'shop', capabilities: ['crypto:*'] } : null,
    operations: localOperations(crypto.service, {
      partition: '',
      capabilities: ['crypto:*'],
      actor: 'server',
    }),
    operationsFor: (app, actor) =>
      localOperations(crypto.service, {
        partition: app,
        capabilities: ['crypto:*'],
        actor,
      }),
    status: () => ({ topology: 'control-plane', partition: '', mode: 'local' }),
  };
  return { crypto, runtime };
}

const call = (id: string, overrides: Partial<TransportCallMessage> = {}): TransportCallMessage => ({
  v: TRANSPORT_MESSAGE_VERSION,
  id,
  operation: 'encrypt',
  input: { key: 'media', plaintext: 'via durable' },
  token: TENANT_TOKEN,
  issuedAt: Date.now(),
  ...overrides,
});

describe('durable driver', () => {
  it('starts crypto.call with the envelope and takes the run output as the reply', async () => {
    const { crypto, runtime } = controlPlane();
    await crypto.service.createKey(crypto.principal, { name: 'media', type: 'aes256-gcm' });
    const started: Array<{ workflow: string; runId: string }> = [];

    const engine: DurableEngineLike = {
      async start(workflow, input, runId) {
        started.push({ workflow, runId });
        return { status: 'completed', output: await handleTransportCall(input, { runtime }) };
      },
    };
    const driver = durableTransport({ engine });

    const reply = await driver.request(call('call-1'), 1000);

    expect(reply).toMatchObject({ ok: true, id: 'call-1' });
    expect((reply.result as { ciphertext: string }).ciphertext).toContain('agora:ct1:media');
    // The message id is the durable run id, so a redelivered call cannot start a second run.
    expect(started).toEqual([{ workflow: 'crypto.call', runId: 'call-1' }]);

    const audit = await crypto.service.audit(crypto.principal, { page: 1, size: 10 });
    expect(audit.data.some((row) => row.key === 'media' && row.operation === 'encrypt')).toBe(true);
  });

  it('runs the workflow through the store-less run gateway ({ runId }) when given one', async () => {
    const { crypto, runtime } = controlPlane();
    await crypto.service.createKey(crypto.principal, { name: 'media', type: 'aes256-gcm' });
    const seen: Array<{ workflow: string; runId: string | undefined }> = [];

    const gateway: DurableGatewayLike = {
      async start(workflow, input, opts) {
        seen.push({ workflow, runId: opts?.runId });
        return { status: 'completed', output: await handleTransportCall(input, { runtime }) };
      },
    };
    // A getter, the config-file friendly form (`() => app.container.make(...)`).
    const driver = durableTransport({ gateway: () => gateway });

    const reply = await driver.request(call('gw-1'), 1000);

    expect(reply).toMatchObject({ ok: true, id: 'gw-1' });
    expect(seen).toEqual([{ workflow: 'crypto.call', runId: 'gw-1' }]);
  });

  it('surfaces a failed run as unavailable, never a hang', async () => {
    const engine: DurableEngineLike = {
      async start() {
        return { status: 'failed', error: new Error('worker exploded') };
      },
    };
    await expect(durableTransport({ engine }).request(call('call-2'), 1000)).rejects.toMatchObject({
      name: 'TransportError',
      code: 'unavailable',
    });
  });

  it('gives up on a run that never settles and returns a timeout', async () => {
    const engine: DurableEngineLike = {
      start: () => new Promise(() => {}),
    };
    await expect(
      durableTransport({ engine, timeoutMs: 25 }).request(call('call-3'), 0),
    ).rejects.toBeInstanceOf(TransportError);
  });

  it('refuses a completed run whose output is not a reply', async () => {
    const engine: DurableEngineLike = {
      async start() {
        return { status: 'completed', output: 'not a reply' };
      },
    };
    await expect(durableTransport({ engine }).request(call('call-4'), 1000)).rejects.toMatchObject({
      code: 'malformed',
    });
  });

  it('needs an engine or a gateway', () => {
    expect(() => durableTransport({})).toThrow(TypeError);
    expect(() =>
      durableTransport({ engine: { start: async () => ({ status: 'completed' }) }, gateway: {} }),
    ).toThrow(TypeError);
  });
});

describe('handleTransportCall', () => {
  it('verifies the token, runs the operation and dedupes the message id', async () => {
    const { crypto, runtime } = controlPlane();
    await crypto.service.createKey(crypto.principal, { name: 'media', type: 'aes256-gcm' });

    const first = await handleTransportCall(call('once'), { runtime });
    expect(first).toMatchObject({ ok: true, id: 'once' });

    const again = await handleTransportCall(call('once'), { runtime });
    expect(again).toMatchObject({ ok: false, error: { code: 'conflict' } });
  });

  it('refuses a bad token with an unauthenticated reply', async () => {
    const { runtime } = controlPlane();
    const reply = await handleTransportCall(call('bad', { token: 'nope' }), { runtime });
    expect(reply).toMatchObject({ ok: false, error: { code: 'unauthenticated' } });
  });

  it('explains that a server without verifyTenant cannot handle a call', async () => {
    const { runtime } = controlPlane();
    const { verifyTenant: _omit, ...withoutVerifier } = runtime;
    expect(() => handleTransportCall(call('nope'), { runtime: withoutVerifier })).toThrow(
      /needs `verifyTenant`/,
    );
  });
});
