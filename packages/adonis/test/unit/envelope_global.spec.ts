import { Readable } from 'node:stream';
import {
  cryptoEnvelope,
  ENVELOPE_FIELD,
  ENVELOPE_HEADER,
  ENVELOPE_VERSION,
  type EnvelopeCipher,
} from '@adonis-agora/crypto-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DISCOVERY_SLOT,
  ENVELOPE_KEY_HEADER,
  type InstallEnvelopeOptions,
  installCryptoEnvelope,
  type ResolvedInboundEnvelope,
} from '../../src/http/envelope_global.js';
import CryptoEnvelopeInboundMiddleware from '../../src/http/envelope_global_middleware.js';

/* --------------------------------------------------------------------------------------------- */
/* A dispatcher with the same composition contract undici has                                     */
/* --------------------------------------------------------------------------------------------- */

type DispatchOptions = {
  origin?: string;
  path: string;
  method: string;
  headers: Record<string, string>;
  body?: unknown;
};
type Dispatch = (options: DispatchOptions, handler: unknown) => boolean;

interface Dispatcher {
  dispatch: Dispatch;
  compose(interceptors: Array<(dispatch: Dispatch) => Dispatch>): Dispatcher;
}

function dispatcherWith(dispatch: Dispatch): Dispatcher {
  const build = (inner: Dispatch): Dispatcher => ({
    dispatch: inner,
    compose(interceptors) {
      return build(interceptors.reduceRight((next, interceptor) => interceptor(next), inner));
    },
  });
  return build(dispatch);
}

const V1 = Symbol.for('undici.globalDispatcher.1');
const V2 = Symbol.for('undici.globalDispatcher.2');
const globals = globalThis as Record<symbol, Dispatcher | undefined>;

/** Records the request the interceptor handed to the real dispatcher. */
function capture() {
  const sent: DispatchOptions[] = [];
  const dispatcher = dispatcherWith((options) => {
    sent.push(options);
    return true;
  });
  return { sent, dispatcher };
}

async function bodyOf(body: unknown): Promise<string> {
  if (typeof body === 'string') return body;
  const chunks: Buffer[] = [];
  for await (const chunk of body as AsyncIterable<Buffer>) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

/** base64 in, base64 out: enough to prove the value travelled and can be opened. */
const base64Cipher: EnvelopeCipher = {
  async encrypt({ plaintext }) {
    return { ciphertext: Buffer.from(plaintext, 'utf8').toString('base64') };
  },
  async decrypt({ ciphertext }) {
    return { plaintext: Buffer.from(ciphertext, 'base64').toString('utf8') };
  },
};

let savedV1: Dispatcher | undefined;
let savedV2: Dispatcher | undefined;
let savedDiscovery: unknown;

beforeEach(() => {
  savedV1 = globals[V1];
  savedV2 = globals[V2];
  savedDiscovery = (globalThis as Record<symbol, unknown>)[DISCOVERY_SLOT];
  delete (globalThis as Record<symbol, unknown>)[DISCOVERY_SLOT];
});

afterEach(() => {
  if (savedV1) globals[V1] = savedV1;
  else delete globals[V1];
  if (savedV2) globals[V2] = savedV2;
  else delete globals[V2];
  if (savedDiscovery === undefined) delete (globalThis as Record<symbol, unknown>)[DISCOVERY_SLOT];
  else (globalThis as Record<symbol, unknown>)[DISCOVERY_SLOT] = savedDiscovery;
});

function publishDiscovery(apps: Record<string, string>) {
  const byOrigin = new Map(Object.entries(apps).map(([name, url]) => [url, name]));
  (globalThis as Record<symbol, unknown>)[DISCOVERY_SLOT] = {
    resolve: (name: string) => apps[name],
    appOf: (origin: string) => byOrigin.get(origin),
    subscribe: () => () => {},
  };
}

async function install(
  config: InstallEnvelopeOptions['config'],
  cipher: EnvelopeCipher = base64Cipher,
): Promise<DispatchOptions[]> {
  const { sent, dispatcher } = capture();
  // Both slots: Node 24's fetch reads `.1`, Node 26's reads `.2`. Setting both also keeps the
  // installer from triggering a real `data:` fetch that would replace this fake with Node's own.
  globals[V1] = dispatcher;
  globals[V2] = dispatcher;
  await installCryptoEnvelope({
    config,
    outboundCipher: cipher,
    inboundCipher: cipher,
    skipPaths: ['/_crypto'],
  });
  return sent;
}

interface HandlerState {
  errors: Error[];
}

/** Runs one dispatch with a handler, and lets the interceptor's async seal land. */
async function dispatch(options: DispatchOptions): Promise<HandlerState> {
  const state: HandlerState = { errors: [] };
  const handler = {
    onResponseError(_controller: unknown, error: Error) {
      state.errors.push(error);
    },
    onError(error: Error) {
      state.errors.push(error);
    },
  };
  globals[V1]!.dispatch(options, handler);
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  return state;
}

const post = (url: string, body: unknown, headers: Record<string, string> = {}) => {
  const parsed = new URL(url);
  return {
    origin: parsed.origin,
    path: parsed.pathname,
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body,
  } satisfies DispatchOptions;
};

function decode(wire: string): { body: unknown; iat: number } {
  const field = (JSON.parse(wire) as Record<string, string>)[ENVELOPE_FIELD]!;
  return JSON.parse(Buffer.from(field, 'base64').toString('utf8')) as {
    body: unknown;
    iat: number;
  };
}

/* --------------------------------------------------------------------------------------------- */
/* Outbound                                                                                        */
/* --------------------------------------------------------------------------------------------- */

describe('envelope interceptor — target identification', () => {
  it('seals for an app telescope discovery knows, without a static targets map', async () => {
    publishDiscovery({ billing: 'https://billing.internal' });
    const sent = await install({ key: 'svc-hub' });

    await dispatch(post('https://billing.internal/v1/charge', '{"amount":10}'));

    expect(sent).toHaveLength(1);
    const wire = sent[0]!;
    expect(wire.headers[ENVELOPE_HEADER]).toBe(ENVELOPE_VERSION);
    expect(wire.headers[ENVELOPE_KEY_HEADER]).toBe('svc-hub');
    expect(wire.headers['content-length']).toBeUndefined();
    expect(decode(await bodyOf(wire.body)).body).toEqual({ amount: 10 });
  });

  it('falls back to the static map when telescope is absent', async () => {
    const sent = await install({
      key: 'svc-hub',
      targets: { billing: 'https://billing.internal' },
    });

    await dispatch(post('https://billing.internal/v1/charge', '{"a":1}'));

    expect(sent).toHaveLength(1);
    expect(sent[0]!.headers[ENVELOPE_HEADER]).toBe(ENVELOPE_VERSION);
    expect(decode(await bodyOf(sent[0]!.body)).body).toEqual({ a: 1 });
  });

  it('leaves an origin that is neither discovered nor configured untouched', async () => {
    const sent = await install({
      key: 'svc-hub',
      targets: { billing: 'https://billing.internal' },
    });

    await dispatch(post('https://unknown.internal/v1/charge', '{"a":1}'));

    expect(sent[0]!.headers[ENVELOPE_HEADER]).toBeUndefined();
    expect(await bodyOf(sent[0]!.body)).toBe('{"a":1}');
  });

  it('never seals crypto’s own API (a seal would need another seal)', async () => {
    publishDiscovery({ billing: 'https://billing.internal' });
    const sent = await install({ key: 'svc-hub' });

    globals[V1]!.dispatch(
      post('https://billing.internal/_crypto/v1/encrypt', '{"a":1}'),
      undefined,
    );

    expect(sent[0]!.headers[ENVELOPE_HEADER]).toBeUndefined();
  });

  it('never seals twice (cryptoFetch, or a second crypto interceptor in the chain)', async () => {
    publishDiscovery({ billing: 'https://billing.internal' });
    const sent = await install({ key: 'svc-hub' });

    await dispatch(
      post('https://billing.internal/v1/charge', '{"a":1}', {
        [ENVELOPE_HEADER]: ENVELOPE_VERSION,
      }),
    );

    expect(await bodyOf(sent[0]!.body)).toBe('{"a":1}');
  });

  it('leaves a non-text body (multipart) alone', async () => {
    publishDiscovery({ billing: 'https://billing.internal' });
    const sent = await install({ key: 'svc-hub' });

    await dispatch(
      post('https://billing.internal/upload', 'binary', {
        'content-type': 'multipart/form-data; boundary=x',
      }),
    );

    expect(sent[0]!.headers[ENVELOPE_HEADER]).toBeUndefined();
  });

  it('seals a symbolic single-label host when discovery knows the name (not yet rewritten)', async () => {
    publishDiscovery({ billing: 'https://billing.internal' });
    const sent = await install({ key: 'svc-hub' });

    await dispatch(post('http://billing/v1/charge', '{"a":1}'));

    expect(sent[0]!.headers[ENVELOPE_HEADER]).toBe(ENVELOPE_VERSION);
  });

  it('seals with a discovery slot that only implements appOf (resolve is optional)', async () => {
    (globalThis as Record<symbol, unknown>)[DISCOVERY_SLOT] = {
      appOf: (origin: string) => (origin === 'https://billing.internal' ? 'billing' : undefined),
    };
    const sent = await install({ key: 'svc-hub' });

    await dispatch(post('https://billing.internal/v1/charge', '{"a":1}'));
    expect(sent[0]!.headers[ENVELOPE_HEADER]).toBe(ENVELOPE_VERSION);

    // Without `resolve`, a symbolic host cannot be identified yet: telescope must rewrite first.
    await dispatch(post('http://billing/v1/charge', '{"a":1}'));
    expect(sent[1]!.headers[ENVELOPE_HEADER]).toBeUndefined();
  });

  it('keeps every header when the dispatcher hands it a Headers instance', async () => {
    publishDiscovery({ billing: 'https://billing.internal' });
    const sent = await install({ key: 'svc-hub' });

    const options = post('https://billing.internal/v1/charge', '{"a":1}');
    options.headers = new Headers({
      'content-type': 'application/json',
      authorization: 'Bearer tenant-token',
    }) as never;
    await dispatch(options);

    expect(sent[0]!.headers.authorization).toBe('Bearer tenant-token');
    expect(sent[0]!.headers[ENVELOPE_HEADER]).toBe(ENVELOPE_VERSION);
    expect(sent[0]!.headers['content-type']).toBe('application/json');
  });

  it('composes with an interceptor that was already there instead of replacing it', async () => {
    publishDiscovery({ billing: 'https://billing.internal' });
    const seen: string[] = [];
    const trace =
      (dispatch: Dispatch): Dispatch =>
      (options, handler) => {
        seen.push(`trace:${options.path}`);
        return dispatch(options, handler);
      };
    globals[V1] = dispatcherWith((options) => {
      seen.push(`terminal:${options.path}`);
      return true;
    }).compose([trace]);

    await installCryptoEnvelope({
      config: { key: 'svc-hub' },
      outboundCipher: base64Cipher,
      inboundCipher: base64Cipher,
      skipPaths: ['/_crypto'],
    });
    await dispatch(post('https://billing.internal/v1/charge', '{"a":1}'));

    expect(seen).toEqual(['trace:/v1/charge', 'terminal:/v1/charge']);
  });

  it('fails the request when sealing fails — plaintext is never sent', async () => {
    publishDiscovery({ billing: 'https://billing.internal' });
    const failing: EnvelopeCipher = {
      async encrypt() {
        throw new Error('the crypto server is down');
      },
      async decrypt() {
        throw new Error('unused');
      },
    };
    const sent = await install({ key: 'svc-hub' }, failing);

    const state = await dispatch(post('https://billing.internal/v1/charge', '{"secret":1}'));

    // The request was failed through the handler: it never reached the dispatcher.
    expect(sent).toHaveLength(0);
    expect(state.errors).toHaveLength(1);
    expect(state.errors[0]!.message).toMatch(/crypto server is down/);
  });

  it('refuses to install outbound sealing without a key', async () => {
    await expect(
      installCryptoEnvelope({
        config: { targets: { billing: 'https://billing.internal' } },
        outboundCipher: base64Cipher,
        inboundCipher: base64Cipher,
      }),
    ).rejects.toThrow(/envelope.key/);
  });
});

/* --------------------------------------------------------------------------------------------- */
/* Inbound                                                                                         */
/* --------------------------------------------------------------------------------------------- */

function inboundOf(overrides: Partial<ResolvedInboundEnvelope> = {}): ResolvedInboundEnvelope {
  return {
    accept: ['svc-hub'],
    cipher: base64Cipher,
    maxAgeSec: 300,
    clockSkewSec: 60,
    maxBytes: 1024 * 1024,
    required: false,
    ...overrides,
  };
}

interface FakeState {
  status: number;
  body: unknown;
  json: unknown;
  envelope: ResolvedInboundEnvelope;
  incomingHeaders: Record<string, string>;
}

function contextOf(input: {
  headers?: Record<string, string>;
  raw?: string;
  body?: unknown;
  envelope?: ResolvedInboundEnvelope;
}) {
  const headers = Object.keys(input.headers ?? {}).reduce<Record<string, string>>((all, name) => {
    all[name.toLowerCase()] = input.headers![name]!;
    return all;
  }, {});
  const state: FakeState = {
    status: 200,
    body: { initial: true },
    json: undefined,
    envelope: input.envelope ?? inboundOf(),
    incomingHeaders: { 'content-length': String(input.raw?.length ?? 0) },
  };
  const request = {
    header: (name: string) => headers[name.toLowerCase()],
    body: () => input.body ?? {},
    raw: () => undefined as string | null,
    request: Object.assign(Readable.from([Buffer.from(input.raw ?? '')]), {
      headers: state.incomingHeaders,
    }),
    updateBody: (body: unknown) => {
      state.body = body;
    },
  };
  const ctx = {
    request,
    response: {
      status(code: number) {
        state.status = code;
        return {
          json(body: unknown) {
            state.json = body;
          },
        };
      },
    },
    containerResolver: {
      async make() {
        return { envelope: state.envelope };
      },
    },
    agora: undefined as unknown,
  };
  return { ctx: ctx as never, state };
}

async function run(context: ReturnType<typeof contextOf>): Promise<number> {
  const middleware = new CryptoEnvelopeInboundMiddleware();
  let next = 0;
  await middleware.handle(context.ctx, async () => {
    next += 1;
  });
  return next;
}

async function sealed(
  payload: unknown,
  key = 'svc-hub',
): Promise<{ raw: string; headers: Record<string, string> }> {
  const envelope = cryptoEnvelope({ client: base64Cipher, key });
  const ciphertext = await envelope.seal(payload);
  return {
    raw: JSON.stringify({ [ENVELOPE_FIELD]: ciphertext }),
    headers: { [ENVELOPE_HEADER]: ENVELOPE_VERSION, [ENVELOPE_KEY_HEADER]: key },
  };
}

describe('envelope inbound middleware', () => {
  it('opens the envelope into request.body() and ctx.agora.envelope before the route', async () => {
    const wire = await sealed({ hello: 'world' });
    const context = contextOf(wire);

    expect(await run(context)).toBe(1);

    expect(context.state.status).toBe(200);
    expect(context.state.body).toEqual({ hello: 'world' });
    expect(
      (context.ctx as unknown as { agora: { envelope: { key: string; payload: unknown } } }).agora
        .envelope,
    ).toMatchObject({ key: 'svc-hub', payload: { hello: 'world' } });
    // The router-level body parser must not try to read a stream this middleware consumed.
    expect(context.state.incomingHeaders['content-length']).toBeUndefined();
    expect(context.state.incomingHeaders['transfer-encoding']).toBeUndefined();
  });

  it('answers 400 with one generic message when the envelope does not open', async () => {
    const context = contextOf({
      headers: { [ENVELOPE_HEADER]: ENVELOPE_VERSION, [ENVELOPE_KEY_HEADER]: 'svc-hub' },
      raw: JSON.stringify({ [ENVELOPE_FIELD]: 'bm90IGFuIGVudmVsb3Bl' }),
    });

    expect(await run(context)).toBe(0);
    expect(context.state.status).toBe(400);
    expect(context.state.json).toEqual({
      code: 'invalid',
      error: 'crypto: the request envelope could not be opened',
    });
  });

  it('refuses a key this app does not accept, without echoing the key it got', async () => {
    const context = contextOf({
      headers: { [ENVELOPE_HEADER]: ENVELOPE_VERSION, [ENVELOPE_KEY_HEADER]: 'someone-else' },
      raw: '{}',
    });

    expect(await run(context)).toBe(0);
    expect(context.state.status).toBe(400);
    expect(JSON.stringify(context.state.json)).not.toContain('someone-else');
  });

  it('passes a request without an envelope through unless it is required', async () => {
    const open = contextOf({});
    expect(await run(open)).toBe(1);
    expect(open.state.body).toEqual({ initial: true });

    const required = contextOf({ envelope: inboundOf({ required: true }) });
    expect(await run(required)).toBe(0);
    expect(required.state.status).toBe(400);
    expect(required.state.json).toEqual({
      code: 'malformed',
      error: 'crypto: this app only accepts encrypted requests',
    });
  });

  it('keeps an array payload on ctx.agora.envelope (a body must be an object)', async () => {
    const wire = await sealed([1, 2, 3]);

    const context = contextOf(wire);
    expect(await run(context)).toBe(1);
    expect(context.state.body).toEqual({});
    expect(
      (context.ctx as unknown as { agora: { envelope: { payload: unknown } } }).agora.envelope
        .payload,
    ).toEqual([1, 2, 3]);
  });

  it('answers 413 for an envelope bigger than the cap', async () => {
    const wire = await sealed({ a: 1 });
    const context = contextOf({ ...wire, envelope: inboundOf({ maxBytes: 4 }) });

    expect(await run(context)).toBe(0);
    expect(context.state.status).toBe(413);
    expect(context.state.json).toMatchObject({ code: 'too_large' });
  });
});
