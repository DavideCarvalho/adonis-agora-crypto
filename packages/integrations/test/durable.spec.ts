import { describe, expect, it } from 'vitest';
import { memoryCrypto } from '../../adonis/src/testing/index.js';
import { encryptedControlPlane, encryptedTransport } from '../src/durable.js';

function setup() {
  const crypto = memoryCrypto();
  return { crypto, source: { service: crypto.service, partition: 'shop' } as const };
}

type Task = {
  runId: string;
  seq: number;
  stepId: string;
  name: string;
  group: string;
  attempt: number;
  input?: unknown;
};
type Result = {
  runId: string;
  seq: number;
  stepId: string;
  status: 'completed' | 'failed';
  output?: unknown;
  error?: unknown;
};
type Beat = { runId: string; stepId: string; group: string; progress?: unknown };

/** A transport in memory, shaped like durable's, so both sides can run in one process. */
function transport() {
  const results: Array<(result: Result) => Promise<void>> = [];
  const beats: Array<(beat: Beat) => Promise<void>> = [];
  const dispatched: Task[] = [];
  return {
    dispatched,
    async dispatch(task: Task) {
      dispatched.push(task);
    },
    onResult(handler: (result: Result) => Promise<void>) {
      results.push(handler);
    },
    onHeartbeat(handler: (beat: Beat) => Promise<void>) {
      beats.push(handler);
    },
    async emitResult(result: Result) {
      for (const handler of results) await handler(result);
    },
    async emitBeat(beat: Beat) {
      for (const handler of beats) await handler(beat);
    },
  };
}

describe('encryptedTransport', () => {
  it('seals the task input and the step output, leaving routing metadata in clear', async () => {
    const { crypto, source } = setup();
    await crypto.service.createKey(crypto.principal, { name: 'durable-tasks', type: 'aes256-gcm' });
    const engineSide = transport();
    const workerSide = transport();
    const engine = encryptedTransport(engineSide, { source, key: 'durable-tasks' });
    const worker = encryptedTransport(workerSide, { source, key: 'durable-tasks' });

    await engine.dispatch({
      runId: 'run-1',
      seq: 3,
      stepId: 'run-1:3',
      name: 'exames.classificar',
      group: 'pipeline',
      attempt: 1,
      input: { paciente: 'Maria', laudo: 'hemograma' },
    });

    const wire = engineSide.dispatched[0]!;
    // Routing stays readable: dedupe and queueing depend on it.
    expect(wire).toMatchObject({
      runId: 'run-1',
      seq: 3,
      stepId: 'run-1:3',
      name: 'exames.classificar',
      group: 'pipeline',
      attempt: 1,
    });
    expect(wire.input).toMatchObject({ agoraSealed: expect.any(String) });
    expect(JSON.stringify(wire)).not.toContain('Maria');

    // The worker decorator opens it before the worker handler runs.
    const received: unknown[] = [];
    worker.onResult(async (result) => {
      received.push(result.output);
    });
    await workerSide.emitResult({
      runId: 'run-1',
      seq: 3,
      stepId: 'run-1:3',
      status: 'completed',
      output: { classificacao: 'normal' },
    });
    expect(received).toEqual([{ classificacao: 'normal' }]);

    // A plain result (not sealed) still passes through.
    await workerSide.emitResult({
      runId: 'run-1',
      seq: 4,
      stepId: 'run-1:4',
      status: 'completed',
      output: 'plain',
    });
    expect(received[1]).toBe('plain');
  });

  it('seals and opens heartbeat progress, and keeps ids clear', async () => {
    const { crypto, source } = setup();
    await crypto.service.createKey(crypto.principal, { name: 'durable-tasks', type: 'aes256-gcm' });
    // An engine seals a progress value by dispatching it; the worker's decorator opens it back.
    const probe = transport();
    await encryptedTransport(probe, { source, key: 'durable-tasks' }).dispatch({
      runId: 'r',
      seq: 1,
      stepId: 'r:1',
      name: 'n',
      group: 'g',
      attempt: 1,
      input: { done: 12, total: 50 },
    });
    const sealedProgress = probe.dispatched[0]!.input;

    const workerSide = transport();
    const worker = encryptedTransport(workerSide, { source, key: 'durable-tasks' });
    const seen: Beat[] = [];
    worker.onHeartbeat(async (beat) => {
      seen.push(beat);
    });
    await workerSide.emitBeat({ runId: 'r', stepId: 'r:1', group: 'g', progress: sealedProgress });
    expect(seen[0]).toMatchObject({
      runId: 'r',
      stepId: 'r:1',
      group: 'g',
      progress: { done: 12, total: 50 },
    });
  });

  it('refuses a plain payload with strict: true', async () => {
    const { crypto, source } = setup();
    await crypto.service.createKey(crypto.principal, { name: 'durable-tasks', type: 'aes256-gcm' });
    const workerSide = transport();
    const worker = encryptedTransport(workerSide, { source, key: 'durable-tasks', strict: true });
    worker.onResult(async () => {});
    await expect(
      workerSide.emitResult({
        runId: 'r',
        seq: 1,
        stepId: 'r:1',
        status: 'completed',
        output: 'plain',
      }),
    ).rejects.toThrow(/sealed payload/);
  });

  it('passes unknown methods straight through', async () => {
    const { crypto, source } = setup();
    await crypto.service.createKey(crypto.principal, { name: 'durable-tasks', type: 'aes256-gcm' });
    const inner = {
      ...transport(),
      useNamespace(namespace: string) {
        return `ns:${namespace}`;
      },
    };
    const wrapped = encryptedTransport(inner, { source, key: 'durable-tasks' });
    expect(wrapped.useNamespace('tenant-a')).toBe('ns:tenant-a');
  });
});

describe('encryptedControlPlane', () => {
  it('seals engine events, keeps routing fields readable, and preserves delivery order', async () => {
    const { crypto, source } = setup();
    await crypto.service.createKey(crypto.principal, { name: 'durable-tasks', type: 'aes256-gcm' });
    const published: Array<Record<string, unknown>> = [];
    const handlers: Array<(message: Record<string, unknown>) => void> = [];
    const inner = {
      async publishControl(message: Record<string, unknown>) {
        published.push(message);
      },
      onControl(handler: (message: Record<string, unknown>) => void) {
        handlers.push(handler);
      },
    };
    const plane = encryptedControlPlane(inner, { source, key: 'durable-tasks', aad: 'control' });

    await plane.publishControl({
      kind: 'event',
      from: 'engine-1',
      runId: 'run-1',
      event: { type: 'completed', output: 'ok' },
    });
    const wire = published[0]!;
    expect(wire).toMatchObject({ kind: 'event', from: 'engine-1', runId: 'run-1' });
    expect(wire.event).toMatchObject({ agoraSealed: expect.any(String) });
    expect(JSON.stringify(wire)).not.toContain('output');

    // Cancel/enqueue messages are routing only and travel in clear.
    await plane.publishControl({ kind: 'cancel', runId: 'run-2' });
    expect(published[1]).toEqual({ kind: 'cancel', runId: 'run-2' });

    const received: Array<Record<string, unknown>> = [];
    plane.onControl((message) => received.push(message));
    const handler = handlers[0]!;
    handler(wire);
    handler({ kind: 'enqueued', runId: 'run-3' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(received[0]).toMatchObject({ kind: 'event', runId: 'run-1' });
    expect(received[0]!.event).toEqual({ type: 'completed', output: 'ok' });
    expect(received[1]).toEqual({ kind: 'enqueued', runId: 'run-3' });
  });

  it('is not readable by a plain control plane, and says so in the docs', async () => {
    const { crypto, source } = setup();
    await crypto.service.createKey(crypto.principal, { name: 'durable-tasks', type: 'aes256-gcm' });
    const published: Array<Record<string, unknown>> = [];
    const inner = {
      async publishControl(message: Record<string, unknown>) {
        published.push(message);
      },
      onControl() {},
    };
    const plane = encryptedControlPlane(inner, { source, key: 'durable-tasks' });
    await plane.publishControl({ kind: 'event', event: { type: 'started' } });
    // A consumer without the decorator receives a sealed event it cannot interpret.
    expect(published[0]!.event).toMatchObject({ agoraSealed: expect.any(String) });
  });
});
