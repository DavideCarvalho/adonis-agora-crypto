import type { Server } from 'node:http';
import { cryptoEnvelope, cryptoFetch, ENVELOPE_FIELD } from '@adonis-agora/crypto-client';
import { afterEach, describe, expect, it } from 'vitest';
import {
  cryptoEnvelopeMiddleware,
  cryptoEnvelopeReply,
  serviceCipher,
} from '../../src/http/envelope.js';
import { memoryCrypto } from '../../src/testing/index.js';
import { addressOf, type Handler, serve } from '../http_harness.js';

interface Route {
  method: string;
  pattern: string;
  handler: Handler;
}

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

function router(routes: Route[]) {
  return {
    get(pattern: string, handler: Handler) {
      routes.push({ method: 'GET', pattern, handler });
      return { as: () => {} };
    },
    post(pattern: string, handler: Handler) {
      routes.push({ method: 'POST', pattern, handler });
      return {};
    },
  };
}

/** A tiny HttpContext: what the middleware touches, plus Adonis' `updateBody` semantics. */
function context(input: { headers?: Record<string, string>; body?: unknown } = {}): {
  ctx: never;
  state: { body: unknown; all: unknown; status: number; sent: unknown; envelope?: unknown };
} {
  const headers = input.headers ?? {};
  const body = input.body ?? {};
  const query: Record<string, unknown> = {};
  const state = {
    body,
    all: {} as unknown,
    status: 200,
    sent: undefined as unknown,
    envelope: undefined as unknown,
  };
  const response = {
    status(code: number) {
      state.status = code;
      return response;
    },
    header() {
      return response;
    },
    json(payload: unknown) {
      state.sent = payload;
      return response;
    },
    send(payload: unknown) {
      state.sent = payload;
      return response;
    },
  };
  const request = {
    header: (name: string) => headers[name.toLowerCase()],
    body: () => state.body,
    qs: () => query,
    all: () => ({ ...(state.body as object), ...query }),
    updateBody(next: unknown) {
      state.body = next;
      state.all = { ...(next as object), ...query };
    },
  };
  const ctx = { request, response } as unknown as {
    request: typeof request;
    response: typeof response;
    cryptoEnvelope?: unknown;
  };
  state.all = request.all();
  void body;
  void query;
  return { ctx: ctx as never, state };
}

describe('envelope middleware', () => {
  it('decrypts the envelope into the request body, so validators read the payload', async () => {
    const { service, principal } = memoryCrypto();
    await service.createKey(principal, { name: 'svc-hooks', type: 'aes256-gcm' });
    const cipher = serviceCipher(service, 'shop');
    const envelope = cryptoEnvelope({ client: cipher, key: 'svc-hooks' });
    const ciphertext = await envelope.seal({ paciente: 'p-1', exame: 'hemograma' });

    const { ctx, state } = context({
      headers: { 'x-crypto-envelope': 'v1' },
      body: { [ENVELOPE_FIELD]: ciphertext },
    });
    let called = false;
    const middleware = cryptoEnvelopeMiddleware({
      service,
      partition: 'shop',
      key: 'svc-hooks',
      required: true,
    });
    await middleware(ctx as never, async () => {
      called = true;
    });
    expect(called).toBe(true);
    expect(state.status).toBe(200);
    expect(state.body).toEqual({ paciente: 'p-1', exame: 'hemograma' });
    expect(state.all).toMatchObject({ paciente: 'p-1' });
    expect((ctx as { cryptoEnvelope?: { payload: unknown } }).cryptoEnvelope?.payload).toEqual({
      paciente: 'p-1',
      exame: 'hemograma',
    });
  });

  it('passes an unencrypted request through unless required', async () => {
    const { service, principal } = memoryCrypto();
    await service.createKey(principal, { name: 'svc-hooks', type: 'aes256-gcm' });
    let called = 0;
    const optional = cryptoEnvelopeMiddleware({ service, partition: 'shop', key: 'svc-hooks' });
    const plain = context({ body: { ok: true } });
    await optional(plain.ctx as never, async () => {
      called += 1;
    });
    expect(called).toBe(1);

    const required = cryptoEnvelopeMiddleware({
      service,
      partition: 'shop',
      key: 'svc-hooks',
      required: true,
    });
    const missing = context({ body: { ok: true } });
    await required(missing.ctx as never, async () => {
      called += 1;
    });
    expect(called).toBe(1);
    expect(missing.state.status).toBe(400);
    expect(missing.state.sent).toMatchObject({ code: 'malformed' });
  });

  it('refuses a tampered, stale or foreign envelope with a wire code', async () => {
    const { service, principal } = memoryCrypto();
    await service.createKey(principal, { name: 'svc-hooks', type: 'aes256-gcm' });
    const cipher = serviceCipher(service, 'shop');
    const envelope = cryptoEnvelope({ client: cipher, key: 'svc-hooks' });
    const ciphertext = await envelope.seal({ ok: true });
    const middleware = cryptoEnvelopeMiddleware({ service, partition: 'shop', key: 'svc-hooks' });

    const tampered = context({
      headers: { 'x-crypto-envelope': 'v1' },
      body: { [ENVELOPE_FIELD]: `${ciphertext.slice(0, -2)}aa` },
    });
    await middleware(tampered.ctx as never, async () => {});
    expect(tampered.state.status).toBe(400);
    expect(tampered.state.sent).toMatchObject({ code: 'invalid' });

    const staleCipher = cryptoEnvelope({
      client: cipher,
      key: 'svc-hooks',
      now: () => Date.now() - 3_600_000,
    });
    const stale = context({
      headers: { 'x-crypto-envelope': 'v1' },
      body: { [ENVELOPE_FIELD]: await staleCipher.seal({ ok: true }) },
    });
    await middleware(stale.ctx as never, async () => {});
    expect(stale.state.sent).toMatchObject({ code: 'stale' });

    const foreign = cryptoEnvelope({ client: cipher, key: 'svc-hooks', aad: 'payments' });
    const contextMismatch = context({
      headers: { 'x-crypto-envelope': 'v1' },
      body: { [ENVELOPE_FIELD]: await foreign.seal({ ok: true }) },
    });
    await middleware(contextMismatch.ctx as never, async () => {});
    expect(contextMismatch.state.sent).toMatchObject({ code: 'invalid' });
  });

  it('answers with a 400 when the body is not an envelope at all', async () => {
    const { service, principal } = memoryCrypto();
    await service.createKey(principal, { name: 'svc-hooks', type: 'aes256-gcm' });
    const middleware = cryptoEnvelopeMiddleware({
      service,
      partition: 'shop',
      key: 'svc-hooks',
      required: true,
    });
    const empty = context({ headers: { 'x-crypto-envelope': 'v1' }, body: {} });
    await middleware(empty.ctx as never, async () => {});
    expect(empty.state.sent).toMatchObject({ code: 'malformed' });
    const version = context({ headers: { 'x-crypto-envelope': 'v9' }, body: {} });
    await middleware(version.ctx as never, async () => {});
    expect(version.state.status).toBe(400);
  });
});

describe('cryptoFetch against the middleware (two services, one crypto server)', () => {
  it('encrypts the request and the response without either side seeing a plaintext on the wire', async () => {
    const { service, principal } = memoryCrypto();
    await service.createKey(principal, { name: 'svc-hooks', type: 'aes256-gcm' });
    const cipher = serviceCipher(service, 'shop');
    const middleware = cryptoEnvelopeMiddleware({
      service,
      partition: 'shop',
      key: 'svc-hooks',
      required: true,
    });

    const routes: Route[] = [];
    const r = router(routes);
    r.post('/internal/procedure', async (ctx) => {
      const received: Array<Record<string, unknown>> = [];
      await middleware(ctx, async () => {
        received.push(
          (ctx as unknown as { request: { body(): Record<string, unknown> } }).request.body(),
        );
      });
      const payload = received[0] ?? {};
      await cryptoEnvelopeReply(
        ctx as never,
        { accepted: true, procedure: payload.procedure },
        { service, partition: 'shop', key: 'svc-hooks' },
      );
    });
    const server = await serve(routes);
    servers.push(server);

    const fetchImpl = cryptoFetch({ client: cipher, key: 'svc-hooks' });
    const response = await fetchImpl(`${addressOf(server)}/internal/procedure`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer tenant-token' },
      body: JSON.stringify({ procedure: 'hemograma', patient: 'Maria' }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ accepted: true, procedure: 'hemograma' });

    const audit = await service.audit(
      { partition: 'shop', capabilities: ['crypto:*'], actor: 'test' },
      { page: 1, size: 20 },
    );
    expect(audit.data.some((row) => row.operation === 'encrypt' && row.result === 'ok')).toBe(true);
    expect(audit.data.some((row) => row.operation === 'decrypt' && row.result === 'ok')).toBe(true);
    // The audit trail never holds the payload.
    expect(JSON.stringify(audit.data)).not.toContain('Maria');
  });

  it('refuses the call when the envelope key is not allowed by the token', async () => {
    const { service, principal } = memoryCrypto();
    await service.createKey(principal, { name: 'svc-hooks', type: 'aes256-gcm' });
    const limited = serviceCipher(service, 'shop', 'svc:limited');
    // No capability: the local cipher always has crypto:*; simulate a tenant with a narrow token.
    const narrow = {
      encrypt: () => {
        throw new Error('crypto: the token lacks crypto:encrypt:svc-hooks');
      },
      decrypt: () => {
        throw new Error('crypto: the token lacks crypto:decrypt:svc-hooks');
      },
    };
    void limited;
    const fetchImpl = cryptoFetch({ client: narrow, key: 'svc-hooks' });
    await expect(
      fetchImpl('http://x/internal', { method: 'POST', body: JSON.stringify({ a: 1 }) }),
    ).rejects.toThrow(/lacks/);
  });
});
