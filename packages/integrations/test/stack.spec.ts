import { describe, expect, it } from 'vitest';
import { memoryCrypto } from '../../adonis/src/testing/index.js';
import { encryptedControlPlane, encryptedTransport } from '../src/durable.js';
import { flagsEnvelope, flagsEnvelopeFetch } from '../src/flags.js';
import { httpEnvelope } from '../src/http.js';

const STACK = Symbol.for('@adonis-agora/stack');
const HINTS = Symbol.for('@adonis-agora/durable:stack-hints');
const usesOf = (value: object): unknown => (value as Record<symbol, unknown>)[STACK];

function source() {
  const crypto = memoryCrypto();
  return { service: crypto.service, partition: 'shop' } as const;
}

describe('stack descriptor (telescope Architecture page)', () => {
  it('an encrypted transport adds the crypto server and keeps what the inner one carries', () => {
    const inner = {
      dispatch: async () => {},
      onResult: () => {},
      [STACK]: [{ tech: 'redis', connection: 'main', purpose: 'queues' }],
      [HINTS]: [{ kind: 'redis', connection: 'main', purpose: 'queues' }],
    };
    const wrapped = encryptedTransport(inner, { source: source(), key: 'durable-tasks' });
    expect(usesOf(wrapped)).toEqual([
      { tech: 'redis', connection: 'main', purpose: 'queues' },
      { tech: 'kms', label: 'agora-crypto', purpose: 'durable payloads' },
    ]);
    // durable reads its own hints through the wrapper.
    expect((wrapped as unknown as Record<symbol, unknown>)[HINTS]).toBe(inner[HINTS]);
  });

  it('an encrypted control plane says it uses the crypto server for events', () => {
    const plane = encryptedControlPlane(
      { publishControl: async () => {}, onControl: () => {} },
      { source: source(), key: 'durable-tasks' },
    );
    expect(usesOf(plane)).toEqual([
      { tech: 'kms', label: 'agora-crypto', purpose: 'durable events' },
    ]);
  });

  it('the flags and http envelopes tag their fetch, which is what lands in a config', () => {
    expect(usesOf(flagsEnvelope({ source: source() }).fetch)).toEqual([
      { tech: 'kms', label: 'agora-crypto', purpose: 'flags events' },
    ]);
    expect(usesOf(flagsEnvelopeFetch({ source: source() }))).toEqual([
      { tech: 'kms', label: 'agora-crypto', purpose: 'flags events' },
    ]);
    expect(usesOf(httpEnvelope({ source: source(), key: 'svc' }).fetch)).toEqual([
      { tech: 'kms', label: 'agora-crypto', purpose: 'http envelope' },
    ]);
  });
});
