import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { CryptoApi } from '../../src/http/api.js';
import { memoryCrypto } from '../../src/testing/index.js';
import { sharedSecretVerifier } from '../../src/topology/verify.js';
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
    patch(pattern: string, handler: Handler) {
      routes.push({ method: 'PATCH', pattern, handler });
      return {};
    },
    delete(pattern: string, handler: Handler) {
      routes.push({ method: 'DELETE', pattern, handler });
      return {};
    },
  };
}

async function start(
  options: {
    partitions?: Record<string, string | { secret: string; capabilities?: string[] }>;
    prefix?: string;
  } = {},
) {
  const crypto = memoryCrypto();
  const api = new CryptoApi({
    service: crypto.service,
    verifyTenant: sharedSecretVerifier({
      partitions: options.partitions ?? {
        shop: 'shop-secret',
        billing: { secret: 'billing-secret', capabilities: ['crypto:keys:read'] },
      },
    }),
    ...(options.prefix !== undefined ? { prefix: options.prefix } : {}),
  });
  const routes: Route[] = [];
  api.register(router(routes));
  const server = await serve(routes);
  servers.push(server);
  return { base: addressOf(server), crypto };
}

const auth = (app = 'shop', secret = 'shop-secret') => ({
  authorization: `Bearer ${secret}`,
  'x-crypto-app': app,
  'content-type': 'application/json',
});

async function post(base: string, path: string, body: unknown, app?: string, secret?: string) {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: auth(app, secret),
    body: JSON.stringify(body),
  });
}

describe('HTTP API', () => {
  it('serves whoami for the app the secret proves, and refuses another app’s claim', async () => {
    const { base } = await start();
    const response = await fetch(`${base}/_crypto/v1/whoami`, {
      headers: { authorization: 'Bearer shop-secret', 'x-crypto-app': 'shop' },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      resource: 'urn:agora:crypto',
      partition: 'shop',
      capabilities: ['crypto:*'],
    });
    // A shared secret identifies its own app: claiming another one never works (an authkit token
    // ignores the header entirely, see the remote suite).
    const claimed = await fetch(`${base}/_crypto/v1/whoami`, {
      headers: { authorization: 'Bearer shop-secret', 'x-crypto-app': 'billing' },
    });
    expect(claimed.status).toBe(401);
  });

  it('refuses a missing or wrong token with 401 and a wire code', async () => {
    const { base } = await start();
    const anon = await fetch(`${base}/_crypto/v1/keys`);
    expect(anon.status).toBe(401);
    expect(await anon.json()).toMatchObject({ code: 'unauthenticated' });
    const wrong = await fetch(`${base}/_crypto/v1/keys`, {
      headers: { authorization: 'Bearer nope', 'x-crypto-app': 'shop' },
    });
    expect(wrong.status).toBe(401);
  });

  it('runs the whole key lifecycle and every operation over HTTP', async () => {
    const { base } = await start();
    const created = await post(base, '/_crypto/v1/keys', {
      name: 'orders',
      type: 'aes256-gcm',
      exportable: true,
    });
    expect(created.status).toBe(201);

    const encrypted = await post(base, '/_crypto/v1/encrypt', {
      key: 'orders',
      plaintext: 'secret',
      aad: 'row',
    });
    expect(encrypted.status).toBe(200);
    const encryptedBody = (await encrypted.json()) as { ciphertext: string; version: number };
    expect(encryptedBody.version).toBe(1);

    const decrypted = await post(base, '/_crypto/v1/decrypt', {
      key: 'orders',
      ciphertext: encryptedBody.ciphertext,
      aad: 'row',
    });
    expect(await decrypted.json()).toMatchObject({ plaintext: 'secret' });

    const rewrapped = await post(base, '/_crypto/v1/rewrap', {
      key: 'orders',
      ciphertext: encryptedBody.ciphertext,
      aad: 'row',
    });
    expect(await rewrapped.json()).toMatchObject({ version: 1 });

    const dataKey = await post(base, '/_crypto/v1/datakeys', { key: 'orders' });
    expect(await dataKey.json()).toMatchObject({ key: 'orders', version: 1 });

    const batch = await post(base, '/_crypto/v1/encrypt/batch', {
      items: [
        { key: 'orders', plaintext: 'a' },
        { key: 'orders', plaintext: 'b' },
      ],
    });
    expect(((await batch.json()) as { results: unknown[] }).results).toHaveLength(2);

    const rotated = await post(base, '/_crypto/v1/keys/orders/rotate', {});
    expect(await rotated.json()).toMatchObject({ latestVersion: 2 });

    const policy = await fetch(`${base}/_crypto/v1/keys/orders`, {
      method: 'PATCH',
      headers: auth(),
      body: JSON.stringify({ minDecryptionVersion: 2, description: 'pii' }),
    });
    expect(policy.status).toBe(200);
    expect(await policy.json()).toMatchObject({ minDecryptionVersion: 2, description: 'pii' });

    const list = await fetch(`${base}/_crypto/v1/keys?page=1&size=10&sort=-createdAt`, {
      headers: auth(),
    });
    expect(list.status).toBe(200);
    expect((await list.json()).meta).toMatchObject({ total: 1 });

    const one = await fetch(`${base}/_crypto/v1/keys/orders`, { headers: auth() });
    expect((await one.json()).versions).toHaveLength(2);

    const exported = await fetch(`${base}/_crypto/v1/keys/orders/export`, { headers: auth() });
    expect(exported.status).toBe(200);

    const audit = await fetch(`${base}/_crypto/v1/audit?filter[operation]=encrypt`, {
      headers: auth(),
    });
    expect((await audit.json()).data[0]).toMatchObject({ operation: 'encrypt', result: 'ok' });
  });

  it('pages the audit by cursor with after/first, and keeps ?page= on the offset envelope', async () => {
    const { base } = await start();
    await post(base, '/_crypto/v1/keys', { name: 'orders', type: 'aes256-gcm' });
    for (let n = 0; n < 4; n++) {
      await post(base, '/_crypto/v1/encrypt', { key: 'orders', plaintext: `p${n}` });
    }
    const first = await fetch(`${base}/_crypto/v1/audit?first=3&filter[operation]=encrypt`, {
      headers: auth(),
    });
    const one = (await first.json()) as {
      data: Array<{ id: string }>;
      meta: { nextCursor: string; hasNext: boolean; hasPrev: boolean; total?: number };
    };
    expect(one.data).toHaveLength(3);
    expect(one.meta).toMatchObject({ hasNext: true, hasPrev: false });
    expect(one.meta.total).toBeUndefined();
    const second = await fetch(
      `${base}/_crypto/v1/audit?first=3&filter[operation]=encrypt&after=${one.meta.nextCursor}`,
      { headers: auth() },
    );
    const two = (await second.json()) as { data: Array<{ id: string }>; meta: object };
    expect(two.data).toHaveLength(1);
    expect(two.meta).toMatchObject({ hasNext: false, hasPrev: true, nextCursor: null });
    expect(new Set([...one.data, ...two.data].map((row) => row.id)).size).toBe(4);

    const bad = await fetch(`${base}/_crypto/v1/audit?after=garbage`, { headers: auth() });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ code: 'invalid' });

    const legacy = await fetch(`${base}/_crypto/v1/audit?page=1&size=2&filter[operation]=encrypt`, {
      headers: auth(),
    });
    expect((await legacy.json()).meta).toMatchObject({ total: 4, currentPage: 1, lastPage: 2 });
  });

  it('serves sign/verify and the public key of an asymmetric key', async () => {
    const { base } = await start();
    await post(base, '/_crypto/v1/keys', { name: 'webhook', type: 'ed25519' });
    const signed = await post(base, '/_crypto/v1/sign', { key: 'webhook', message: 'body' });
    const { signature } = (await signed.json()) as { signature: string };
    expect(signature.startsWith('agora:sig1:')).toBe(true);
    const verified = await post(base, '/_crypto/v1/verify', {
      key: 'webhook',
      message: 'body',
      signature,
    });
    expect(await verified.json()).toMatchObject({ valid: true });
    const pub = await fetch(`${base}/_crypto/v1/keys/webhook/public`, { headers: auth() });
    expect((await pub.json()).type).toBe('ed25519');
    const jwks = await fetch(`${base}/_crypto/v1/keys/webhook/jwks`, { headers: auth() });
    expect((await jwks.json()).keys).toHaveLength(1);
  });

  it('answers 403 with a wire code when the capability is missing, and audits it', async () => {
    const { base } = await start();
    const created = await post(base, '/_crypto/v1/keys', { name: 'orders', type: 'aes256-gcm' });
    expect(created.status).toBe(201);
    // `billing` holds keys:read only.
    const denied = await post(
      base,
      '/_crypto/v1/encrypt',
      { key: 'orders', plaintext: 'x' },
      'billing',
      'billing-secret',
    );
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({ code: 'forbidden' });
    const list = await fetch(`${base}/_crypto/v1/keys`, {
      headers: auth('billing', 'billing-secret'),
    });
    expect(list.status).toBe(200);
    // No keys of its own yet: the denial still reached the audit trail of the token's app.
    const audit = await fetch(`${base}/_crypto/v1/audit?filter[result]=denied`, {
      headers: auth('billing', 'billing-secret'),
    });
    const body = (await audit.json()) as { data: Array<{ operation: string; result: string }> };
    expect(body.data[0]).toMatchObject({ operation: 'encrypt', result: 'denied' });
  });

  it('never touches another app’s keys: partition comes from the token', async () => {
    const { base } = await start({
      partitions: { shop: 'shop-secret', billing: { secret: 'billing-secret' } },
    });
    await post(base, '/_crypto/v1/keys', { name: 'orders', type: 'aes256-gcm' });
    const billingList = await fetch(`${base}/_crypto/v1/keys`, {
      headers: auth('billing', 'billing-secret'),
    });
    expect((await billingList.json()).meta.total).toBe(0);
    const crossRead = await fetch(`${base}/_crypto/v1/keys/orders`, {
      headers: auth('billing', 'billing-secret'),
    });
    expect(crossRead.status).toBe(404);
  });

  it('rejects a tampered ciphertext as a client error, not a server error', async () => {
    const { base } = await start();
    await post(base, '/_crypto/v1/keys', { name: 'orders', type: 'aes256-gcm' });
    const encrypted = await post(base, '/_crypto/v1/encrypt', {
      key: 'orders',
      plaintext: 'secret',
    });
    const { ciphertext } = (await encrypted.json()) as { ciphertext: string };
    const tampered = ciphertext.replace(/.$/, (char) => (char === 'A' ? 'B' : 'A'));
    const response = await post(base, '/_crypto/v1/decrypt', {
      key: 'orders',
      ciphertext: tampered,
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 'invalid' });
  });

  it('honours a custom prefix and answers 404 outside it', async () => {
    const { base } = await start({ prefix: '/crypto' });
    const inside = await fetch(`${base}/crypto/v1/whoami`, { headers: auth() });
    expect(inside.status).toBe(200);
    const outside = await fetch(`${base}/_crypto/v1/whoami`, { headers: auth() });
    expect(outside.status).toBe(404);
  });
});
