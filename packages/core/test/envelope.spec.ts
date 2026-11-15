import { describe, expect, it } from 'vitest';
import {
  CryptoEnvelopeError,
  cryptoEnvelope,
  cryptoFetch,
  ENVELOPE_FIELD,
  ENVELOPE_HEADER,
  type EnvelopeCipher,
} from '../src/index.js';

const b64 = (text: string) => Buffer.from(text, 'utf8').toString('base64url');

/** A cipher whose "ciphertext" carries the aad, so a mismatched aad fails like a real GCM tag. */
function fakeCipher(): EnvelopeCipher & { calls: number } {
  return {
    calls: 0,
    async encrypt({ aad, plaintext }) {
      this.calls += 1;
      return { ciphertext: `ct1|${aad}|${b64(plaintext)}` };
    },
    async decrypt({ aad, ciphertext }) {
      this.calls += 1;
      const [prefix, bound, body] = String(ciphertext).split('|');
      if (prefix !== 'ct1' || bound !== aad || body === undefined) {
        throw new Error('crypto: did not open');
      }
      const bytes = Buffer.from(body, 'base64url');
      // Strict, like the real ciphertext: a byte changed anywhere fails the tag.
      if (bytes.toString('base64url') !== body) throw new Error('crypto: did not open');
      return { plaintext: bytes.toString('utf8') };
    },
  };
}

describe('cryptoEnvelope', () => {
  it('seals and opens a JSON payload, and the wire carries no plaintext', async () => {
    const cipher = fakeCipher();
    const envelope = cryptoEnvelope({ client: cipher, key: 'svc-flags' });
    const ciphertext = await envelope.seal({ rule: 'checkout', enabled: true });
    expect(ciphertext).not.toContain('checkout');
    expect(ciphertext.startsWith('ct1|agora:envelope:v1:|')).toBe(true);
    expect(await envelope.open(ciphertext)).toEqual({ rule: 'checkout', enabled: true });
    expect(await envelope.open<{ rule: string }>(ciphertext)).toMatchObject({ rule: 'checkout' });
  });

  it('binds an aad context: another context cannot open it', async () => {
    const cipher = fakeCipher();
    const envelope = cryptoEnvelope({ client: cipher, key: 'svc-flags', aad: 'billing' });
    const ciphertext = await envelope.seal({ a: 1 });
    await expect(envelope.open(ciphertext)).resolves.toEqual({ a: 1 });
    const other = cryptoEnvelope({ client: cipher, key: 'svc-flags', aad: 'payments' });
    await expect(other.open(ciphertext)).rejects.toBeInstanceOf(CryptoEnvelopeError);
  });

  it('refuses a stale envelope and one issued in the future', async () => {
    const cipher = fakeCipher();
    let now = Date.parse('2026-01-01T00:00:00Z');
    const envelope = cryptoEnvelope({ client: cipher, key: 'svc', now: () => now });
    const ciphertext = await envelope.seal({ a: 1 });

    now += 301_000;
    await expect(envelope.open(ciphertext)).rejects.toMatchObject({ code: 'stale' });

    now -= 302_000 + 120_000;
    await expect(envelope.open(ciphertext)).rejects.toMatchObject({ code: 'stale' });
  });

  it('refuses a tampered envelope and an empty one', async () => {
    const cipher = fakeCipher();
    const envelope = cryptoEnvelope({ client: cipher, key: 'svc' });
    const ciphertext = await envelope.seal({ a: 1 });
    await expect(envelope.open(`${ciphertext}x`)).rejects.toMatchObject({ code: 'invalid' });
    await expect(envelope.open('')).rejects.toMatchObject({ code: 'malformed' });
  });

  it('refuses a document of another version or without issued-at', async () => {
    const cipher = fakeCipher();
    const envelope = cryptoEnvelope({ client: cipher, key: 'svc' });
    const aad = 'agora:envelope:v1:';
    const v2 = `ct1|${aad}|${b64(JSON.stringify({ v: 2, iat: 1, body: {} }))}`;
    await expect(envelope.open(v2)).rejects.toMatchObject({ code: 'malformed' });
    const noIat = `ct1|${aad}|${b64(JSON.stringify({ v: 1, body: {} }))}`;
    await expect(envelope.open(noIat)).rejects.toMatchObject({ code: 'malformed' });
  });
});

describe('cryptoFetch', () => {
  it('seals the request body and opens the encrypted response', async () => {
    const cipher = fakeCipher();
    const seen: Array<{ body: unknown; headers: Headers }> = [];
    const fakeFetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      const body = JSON.parse(String(init?.body)) as Record<string, string>;
      seen.push({ body, headers });
      // The receiver would read the envelope and answer with an envelope of its own.
      const envelope = cryptoEnvelope({ client: cipher, key: 'svc-flags' });
      const payload = await envelope.open(body[ENVELOPE_FIELD]!);
      const sealed = await envelope.seal({ received: payload });
      return new Response(JSON.stringify({ [ENVELOPE_FIELD]: sealed }), {
        status: 200,
        headers: { 'content-type': 'application/json', [ENVELOPE_HEADER]: 'v1' },
      });
    }) as typeof fetch;

    const fetchImpl = cryptoFetch({ client: cipher, key: 'svc-flags', fetch: fakeFetch });
    const response = await fetchImpl('http://flags.internal/v1/evaluate', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer token' },
      body: JSON.stringify({ rule: 'checkout', context: { userId: '42' } }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      received: { rule: 'checkout', context: { userId: '42' } },
    });
    expect(seen[0]?.headers.get(ENVELOPE_HEADER)).toBe('v1');
    expect(seen[0]?.headers.get('authorization')).toBe('Bearer token');
    const wire = JSON.stringify(seen[0]?.body);
    expect(wire).not.toContain('checkout');
    expect(wire).toContain(ENVELOPE_FIELD);
  });

  it('leaves a non-JSON body and an unencrypted response untouched', async () => {
    const cipher = fakeCipher();
    let sent: unknown;
    const fakeFetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      sent = init?.body;
      return new Response('plain text', { status: 200, headers: { 'content-type': 'text/plain' } });
    }) as typeof fetch;
    const fetchImpl = cryptoFetch({ client: cipher, key: 'svc', fetch: fakeFetch });

    const form = new FormData();
    form.set('file', 'x');
    const response = await fetchImpl('http://x/upload', { method: 'POST', body: form });
    expect(sent).toBe(form);
    expect(await response.text()).toBe('plain text');
    expect(cipher.calls).toBe(0);

    const get = await fetchImpl('http://x/health');
    expect(await get.text()).toBe('plain text');
    expect(cipher.calls).toBe(0);
  });
});
