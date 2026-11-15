import {
  cryptoEnvelope,
  ENVELOPE_FIELD,
  ENVELOPE_HEADER,
  type EnvelopeCipher,
} from '@adonis-agora/crypto-client';
import { describe, expect, it } from 'vitest';
import { memoryCrypto } from '../../adonis/src/testing/index.js';
import { flagsEnvelope, flagsEnvelopeFetch } from '../src/flags.js';
import { httpEnvelope } from '../src/http.js';

function setup() {
  const crypto = memoryCrypto();
  return { crypto, source: { service: crypto.service, partition: 'shop' } as const };
}

function cipherOf(crypto: ReturnType<typeof memoryCrypto>): EnvelopeCipher {
  return {
    encrypt: (input) => crypto.service.encrypt(crypto.principal, input),
    decrypt: (input) => crypto.service.decrypt(crypto.principal, input),
  };
}

/** A fetch that behaves like the receiving side: open the envelope, answer with JSON. */
function receiver(cipher: EnvelopeCipher, key: string, aad?: string) {
  const envelope = cryptoEnvelope({ client: cipher, key, ...(aad ? { aad } : {}) });
  const seen: unknown[] = [];
  const headers: Array<string | null> = [];
  const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    headers.push(new Headers(init?.headers).get(ENVELOPE_HEADER));
    const body = JSON.parse(String(init?.body)) as Record<string, string>;
    seen.push(await envelope.open(body[ENVELOPE_FIELD]!));
    return new Response(JSON.stringify({ accepted: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return { fetchImpl, seen, headers };
}

describe('flags', () => {
  it('seals the event batches a flags transport or sink sends', async () => {
    const { crypto, source } = setup();
    await crypto.service.createKey(crypto.principal, { name: 'flags-events', type: 'aes256-gcm' });
    const server = receiver(cipherOf(crypto), 'flags-events', 'flags');

    const envelope = flagsEnvelope({ source, aad: 'flags', fetch: server.fetchImpl });
    const events = { batch: [{ key: 'checkout-v2', variant: 'on' }] };
    const response = await envelope.fetch('http://flags/_flags/v1/events', {
      method: 'POST',
      body: JSON.stringify(events),
    });

    expect(await response.json()).toEqual({ accepted: true });
    expect(server.seen[0]).toEqual(events);
    expect(server.headers[0]).toBe('v1');
    const audit = await crypto.service.audit(crypto.principal, { page: 1, size: 20 });
    expect(
      audit.data.some((row) => row.key === 'flags-events' && row.operation === 'decrypt'),
    ).toBe(true);
  });

  it('exposes just the fetch, defaulting to the flags key', async () => {
    const { crypto, source } = setup();
    await crypto.service.createKey(crypto.principal, { name: 'flags-events', type: 'aes256-gcm' });
    const server = receiver(cipherOf(crypto), 'flags-events');
    const fetchImpl = flagsEnvelopeFetch({ source, fetch: server.fetchImpl });
    const response = await fetchImpl('http://flags/_flags/v1/events', {
      method: 'POST',
      body: JSON.stringify([{ key: 'a' }]),
    });
    expect(response.status).toBe(200);
    expect(server.seen[0]).toEqual([{ key: 'a' }]);
  });
});

describe('http', () => {
  it('seals a tenant token request and a config fetch with the same helper', async () => {
    const { crypto, source } = setup();
    await crypto.service.createKey(crypto.principal, { name: 'svc-config', type: 'aes256-gcm' });
    const server = receiver(cipherOf(crypto), 'svc-config');
    const envelope = httpEnvelope({ source, key: 'svc-config', fetch: server.fetchImpl });

    const tokenRequest = await envelope.fetch('http://authkit/oauth/token', {
      method: 'POST',
      body: JSON.stringify({ client_id: 'streaming', client_secret: 'secret' }),
    });
    expect(tokenRequest.status).toBe(200);

    await envelope.fetch('http://config/_config/v1/config', {
      method: 'POST',
      body: JSON.stringify({ app: 'streaming' }),
    });
    expect(server.seen).toEqual([
      { client_id: 'streaming', client_secret: 'secret' },
      { app: 'streaming' },
    ]);
    expect(server.headers).toEqual(['v1', 'v1']);
  });
});
