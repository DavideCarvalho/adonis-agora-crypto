import { generateKeyPairSync, sign as nodeSign, verify as nodeVerify } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CryptoClientError,
  createCryptoClient,
  cryptoServerKms,
  cryptoServerSigner,
} from '../src/index.js';

interface Received {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: IncomingMessage['headers'];
  body: unknown;
}

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

type Route = (request: Received, response: ServerResponse, count: number) => unknown;

/** A tiny crypto server: the wire contract only, no real crypto (the server package owns that). */
async function fakeServer(routes: Record<string, Route>) {
  const received: Received[] = [];
  const counts = new Map<string, number>();
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks).toString();
    const url = new URL(req.url ?? '/', 'http://localhost');
    const key = `${req.method} ${url.pathname}`;
    const entry: Received = {
      method: req.method ?? 'GET',
      path: url.pathname,
      query: url.searchParams,
      headers: req.headers,
      body: raw ? JSON.parse(raw) : undefined,
    };
    received.push(entry);
    const count = (counts.get(key) ?? 0) + 1;
    counts.set(key, count);
    const route = routes[key];
    if (!route) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: `no route ${key}`, code: 'not_found' }));
      return;
    }
    const answer = route(entry, res, count);
    if (answer === undefined) return;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(answer));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  servers.push(server);
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('not listening');
  return { url: `http://127.0.0.1:${address.port}/_crypto`, received, counts };
}

const client = (
  url: string,
  options: { token?: string; retries?: number; timeoutMs?: number } = {},
) =>
  createCryptoClient({
    url,
    partition: 'shop',
    token: options.token ?? 'secret',
    ...(options.retries !== undefined ? { retries: options.retries } : {}),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    retryDelayMs: 1,
  });

describe('CryptoClient', () => {
  it('sends the token and the claimed app, and returns the operation results', async () => {
    const { url, received } = await fakeServer({
      'POST /_crypto/v1/encrypt': (request) => ({
        key: (request.body as { key: string }).key,
        version: 3,
        ciphertext: 'agora:ct1:3:abc',
      }),
      'POST /_crypto/v1/decrypt': () => ({ key: 'pii', version: 1, plaintext: 'hello' }),
      'POST /_crypto/v1/rewrap': () => ({ key: 'pii', version: 2, ciphertext: 'agora:ct1:2:def' }),
      'POST /_crypto/v1/datakeys': () => ({
        key: 'root',
        version: 1,
        plaintext: 'datakey',
        wrapped: 'wrapped',
      }),
      'POST /_crypto/v1/sign': () => ({ key: 'signing', kid: 'k1', signature: 'agora:sig1:k1:x' }),
      'POST /_crypto/v1/verify': () => ({ key: 'signing', valid: true }),
      'POST /_crypto/v1/hmac': () => ({ key: 'hmac', hmac: 'digest' }),
    });
    const api = client(url);

    expect(await api.encrypt({ key: 'pii', plaintext: 'hello', aad: 'row-1' })).toEqual({
      key: 'pii',
      version: 3,
      ciphertext: 'agora:ct1:3:abc',
    });
    expect(await api.decrypt({ key: 'pii', ciphertext: 'agora:ct1:3:abc' })).toMatchObject({
      plaintext: 'hello',
    });
    expect(await api.rewrap({ key: 'pii', ciphertext: 'x' })).toMatchObject({ version: 2 });
    expect(await api.generateDataKey({ key: 'root' })).toMatchObject({ plaintext: 'datakey' });
    expect(await api.sign({ key: 'signing', message: 'm' })).toMatchObject({ kid: 'k1' });
    expect(await api.verify({ key: 'signing', message: 'm', signature: 's' })).toMatchObject({
      valid: true,
    });
    expect(await api.hmac({ key: 'hmac', message: 'm' })).toMatchObject({ hmac: 'digest' });

    expect(received[0]?.headers.authorization).toBe('Bearer secret');
    expect(received[0]?.headers['x-crypto-app']).toBe('shop');
    expect(received[0]?.body).toEqual({ key: 'pii', plaintext: 'hello', aad: 'row-1' });
  });

  it('covers the batch endpoints', async () => {
    const { url, received } = await fakeServer({
      'POST /_crypto/v1/encrypt/batch': (request) => ({
        results: (request.body as { items: Array<{ key: string }> }).items.map((item) => ({
          key: item.key,
          version: 1,
          ciphertext: 'c',
        })),
      }),
      'POST /_crypto/v1/decrypt/batch': () => ({
        results: [{ key: 'a', version: 1, plaintext: 'x' }],
      }),
      'POST /_crypto/v1/sign/batch': () => ({ results: [] }),
      'POST /_crypto/v1/verify/batch': () => ({ results: [] }),
    });
    const api = client(url);
    const encrypted = await api.encryptBatch([
      { key: 'a', plaintext: '1' },
      { key: 'b', plaintext: '2' },
    ]);
    expect(encrypted.results).toHaveLength(2);
    expect(await api.decryptBatch([{ key: 'a', ciphertext: 'c' }])).toMatchObject({
      results: [{ plaintext: 'x' }],
    });
    expect(await api.signBatch([])).toEqual({ results: [] });
    expect(await api.verifyBatch([])).toEqual({ results: [] });
    expect(received).toHaveLength(4);
  });

  it('lists keys, reads one, manages it and pages the audit trail', async () => {
    const key = {
      partition: 'shop',
      name: 'pii',
      type: 'aes256-gcm',
      latestVersion: 2,
      minDecryptionVersion: 1,
      deletionAllowed: false,
      exportable: false,
      createdAt: '2026-01-01T00:00:00.000Z',
      createdBy: 'test',
      versions: [],
    };
    const page = {
      data: [key],
      meta: { total: 1, perPage: 50, currentPage: 1, lastPage: 1, firstPage: 1 },
    };
    const { url, received } = await fakeServer({
      'GET /_crypto/v1/keys': () => page,
      'GET /_crypto/v1/keys/pii': () => key,
      'POST /_crypto/v1/keys': () => key,
      'POST /_crypto/v1/keys/pii/rotate': () => ({ ...key, latestVersion: 3 }),
      'PATCH /_crypto/v1/keys/pii': () => ({ ...key, minDecryptionVersion: 2 }),
      'DELETE /_crypto/v1/keys/pii': () => ({ key: 'pii', deleted: true }),
      'GET /_crypto/v1/keys/pii/export': () => ({ key: 'pii', type: 'aes256-gcm', version: 2 }),
      'GET /_crypto/v1/keys/pii/public': () => ({ key: 'pii', kid: 'k', jwk: {} }),
      'GET /_crypto/v1/audit': () => ({ data: [], meta: { total: 0 } }),
      'GET /_crypto/v1/whoami': () => ({ resource: 'urn:agora:crypto', partition: 'shop' }),
    });
    const api = client(url);
    expect(await api.listKeys({ search: 'p', page: 2, size: 10, sort: '-createdAt' })).toEqual(
      page,
    );
    expect(received[0]?.query.get('search')).toBe('p');
    expect(received[0]?.query.get('page')).toBe('2');
    expect(received[0]?.query.get('sort')).toBe('-createdAt');

    expect(await api.getKey('pii')).toMatchObject({ name: 'pii' });
    expect(await api.createKey({ name: 'pii', type: 'aes256-gcm' })).toMatchObject({ name: 'pii' });
    expect(await api.rotateKey('pii')).toMatchObject({ latestVersion: 3 });
    expect(await api.updateKeyPolicy('pii', { minDecryptionVersion: 2 })).toMatchObject({
      minDecryptionVersion: 2,
    });
    expect(await api.deleteKey('pii')).toEqual({ key: 'pii', deleted: true });
    expect(await api.exportKey('pii')).toMatchObject({ key: 'pii' });
    expect(await api.publicKey('pii')).toMatchObject({ kid: 'k' });
    await api.audit({ key: 'pii', operation: 'decrypt', result: 'denied' });
    const auditQuery = received.at(-1)?.query;
    expect(auditQuery?.get('sort')).toBe('-at');
    expect(auditQuery?.get('filter[key]')).toBe('pii');
    expect(auditQuery?.get('filter[operation]')).toBe('decrypt');
    expect(auditQuery?.get('filter[result]')).toBe('denied');
    await api.auditCursor({ after: 'c1', size: 20, result: 'denied' });
    const forward = received.at(-1)?.query;
    expect(forward?.get('after')).toBe('c1');
    expect(forward?.get('first')).toBe('20');
    expect(forward?.get('page')).toBeNull();
    expect(forward?.get('filter[result]')).toBe('denied');
    await api.auditCursor({ before: 'c0' });
    const backward = received.at(-1)?.query;
    expect(backward?.get('before')).toBe('c0');
    expect(backward?.get('last')).toBe('50');
    expect(backward?.get('first')).toBeNull();
    expect(await api.whoami()).toMatchObject({ partition: 'shop' });
  });

  it('resets the token on a 401 and retries once with the fresh one', async () => {
    let resets = 0;
    const { url, counts, received } = await fakeServer({
      'GET /_crypto/v1/whoami': (_request, response, count) => {
        if (count === 1) {
          response.writeHead(401, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ error: 'unauthorized', code: 'unauthenticated' }));
          return undefined;
        }
        return { resource: 'urn:agora:crypto', partition: 'shop' };
      },
    });
    let token = 'stale';
    const api = createCryptoClient({
      url,
      partition: 'shop',
      token: {
        get: async () => token,
        reset: () => {
          resets += 1;
          token = 'fresh';
        },
      },
      retryDelayMs: 1,
    });
    expect(await api.whoami()).toMatchObject({ partition: 'shop' });
    expect(resets).toBe(1);
    expect(counts.get('GET /_crypto/v1/whoami')).toBe(2);
    expect(received[1]?.headers.authorization).toBe('Bearer fresh');
  });

  it('retries a 5xx and gives up after the configured attempts', async () => {
    const { url, counts } = await fakeServer({
      'POST /_crypto/v1/encrypt': (_request, response) => {
        response.writeHead(503, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: 'unavailable', code: 'unreadable' }));
        return undefined;
      },
    });
    const api = client(url, { retries: 2 });
    await expect(api.encrypt({ key: 'a', plaintext: 'b' })).rejects.toMatchObject({
      status: 503,
    });
    // The first attempt plus two retries.
    expect(counts.get('POST /_crypto/v1/encrypt')).toBe(3);
  });

  it('reports the wire error with its status and code', async () => {
    const { url } = await fakeServer({});
    const api = client(url, { retries: 0 });
    await expect(api.decrypt({ key: 'pii', ciphertext: 'x' })).rejects.toMatchObject({
      status: 404,
      code: 'not_found',
    });
    const error = new CryptoClientError(403, 'forbidden', 'nope');
    expect(error.code).toBe('forbidden');
  });

  it('times out and reports it', async () => {
    const { url } = await fakeServer({
      'POST /_crypto/v1/encrypt': (_request, response) => {
        setTimeout(() => {
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ key: 'a', version: 1, ciphertext: 'c' }));
        }, 100);
        return undefined;
      },
    });
    const api = client(url, { timeoutMs: 15, retries: 0 });
    await expect(api.encrypt({ key: 'a', plaintext: 'b' })).rejects.toMatchObject({
      code: 'timeout',
    });
  });
});

describe('cryptoServerKms', () => {
  it('describes itself to telescope as the crypto server KMS, with no URL', () => {
    const adapter = cryptoServerKms({
      client: createCryptoClient({
        url: 'https://crypto.example.com/_crypto',
        partition: 'app',
        token: 't',
      }),
      key: 'config-root',
    });
    expect(
      (adapter as unknown as Record<symbol, unknown>)[Symbol.for('@adonis-agora/stack')],
    ).toEqual([{ tech: 'kms', label: 'agora-crypto', purpose: 'root key' }]);
    expect(Object.keys(adapter)).toEqual(['wrap', 'unwrap']);
  });

  it('wraps and unwraps a data key through the server, bound to the purpose', async () => {
    const { url, received } = await fakeServer({
      'POST /_crypto/v1/encrypt': (request) => {
        const body = request.body as { plaintext: string };
        return { key: 'root', version: 1, ciphertext: `enc:${body.plaintext}` };
      },
      'POST /_crypto/v1/decrypt': (request) => {
        const body = request.body as { ciphertext: string };
        return { key: 'root', version: 1, plaintext: body.ciphertext.replace(/^enc:/, '') };
      },
    });
    const kms = cryptoServerKms({ client: client(url), key: 'root' });
    const dataKey = Buffer.from('0123456789abcdef0123456789abcdef');
    const wrapped = await kms.wrap(dataKey, { purpose: 'config:secrets' });
    expect(Buffer.from(wrapped).toString()).toBe(`enc:${dataKey.toString('base64url')}`);
    const unwrapped = await kms.unwrap(wrapped, { purpose: 'config:secrets' });
    expect(Buffer.from(unwrapped).equals(dataKey)).toBe(true);
    expect((received[0]!.body as { aad: string }).aad).toBe('kms:config:secrets');
  });
});

describe('cryptoServerSigner', () => {
  it('returns kit-compatible signatures and verifies them', async () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const jwk = publicKey.export({ format: 'jwk' }) as { crv: string; kty: string; x: string };
    const { url } = await fakeServer({
      'POST /_crypto/v1/sign': (request) => {
        const body = request.body as { message: string };
        const signature = nodeSign(null, Buffer.from(body.message, 'utf8'), privateKey);
        return {
          key: 'signing',
          kid: 'k1',
          signature: `agora:sig1:k1:${signature.toString('base64url')}`,
        };
      },
      'POST /_crypto/v1/verify': (request) => {
        const body = request.body as { message: string; signature: string };
        const signature = Buffer.from(body.signature.split(':')[3] ?? '', 'base64url');
        return {
          key: 'signing',
          valid: nodeVerify(null, Buffer.from(body.message, 'utf8'), publicKey, signature),
        };
      },
      'GET /_crypto/v1/keys/signing/public': () => ({
        key: 'signing',
        type: 'ed25519',
        kid: 'k1',
        jwk: { ...jwk, kid: 'k1' },
      }),
    });
    const signer = cryptoServerSigner({ client: client(url), key: 'signing' });
    const signature = await signer.sign('payload');
    expect(signature.startsWith('agora:sig1:k1:')).toBe(true);
    expect(await signer.verify('payload', signature)).toBe(true);
    expect(await signer.verify('other', signature)).toBe(false);
    expect((await signer.publicKey()).kid).toBe('k1');
  });
});
