import { createServer, type Server } from 'node:http';
import { authkitTenantToken, authkitTenantVerifier } from '@adonis-agora/authkit-client';
import {
  CryptoClientError,
  createCryptoClient,
  cryptoServerKms,
  cryptoServerSigner,
} from '@adonis-agora/crypto-client';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { afterEach, describe, expect, it } from 'vitest';
import { verify as kitVerify } from '../../src/crypto-kit/index.js';
import { CryptoApi } from '../../src/http/api.js';
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

/** An in-memory OIDC issuer: discovery, JWKS, and a token endpoint that mints real JWTs. */
async function issuer() {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'test-key', alg: 'RS256', use: 'sig' };
  let issued = 0;
  const server = createServer((req, res) => {
    const base = addressOf(server);
    if (req.url === '/.well-known/openid-configuration') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          issuer: base,
          authorization_endpoint: `${base}/authorize`,
          token_endpoint: `${base}/oauth/token`,
          jwks_uri: `${base}/.well-known/jwks.json`,
        }),
      );
      return;
    }
    if (req.url === '/.well-known/jwks.json') {
      res
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ keys: [jwk] }));
      return;
    }
    if (req.url === '/oauth/token' && req.method === 'POST') {
      issued += 1;
      void mint().then((token) => {
        res
          .writeHead(200, { 'content-type': 'application/json' })
          .end(JSON.stringify({ access_token: token, token_type: 'Bearer', expires_in: 300 }));
      });
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  servers.push(server);
  const base = addressOf(server);

  const mint = (
    claims: Record<string, unknown> = {},
    options: { audience?: string; expired?: boolean } = {},
  ) => {
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({
      client_id: 'streaming',
      partition: 'shop',
      capabilities: ['crypto:*'],
      ...claims,
    })
      .setProtectedHeader({ alg: 'RS256', typ: 'at+jwt', kid: 'test-key' })
      .setIssuer(base)
      .setAudience(options.audience ?? 'urn:agora:crypto')
      .setSubject('streaming')
      .setIssuedAt(now)
      .setExpirationTime(options.expired ? now - 60 : now + 600)
      .sign(privateKey);
  };

  return { base, mint, issued: () => issued };
}

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

async function start(issuerUrl: string) {
  const crypto = memoryCrypto();
  const api = new CryptoApi({
    service: crypto.service,
    verifyTenant: authkitTenantVerifier({
      issuer: issuerUrl,
      resource: 'urn:agora:crypto',
    }),
  });
  const routes: Route[] = [];
  api.register(router(routes));
  const server = await serve(routes);
  servers.push(server);
  return { url: `${addressOf(server)}/_crypto`, crypto };
}

describe('remote path (authkit issuer, real authkit-client helpers)', () => {
  it('runs every operation through the typed client with a discovered, verified token', async () => {
    const oidc = await issuer();
    const { url } = await start(oidc.base);
    const token = authkitTenantToken({
      issuer: oidc.base,
      clientId: 'streaming',
      clientSecret: 'secret',
      resource: 'urn:agora:crypto',
    });
    const client = createCryptoClient({ url, partition: 'shop', token, retryDelayMs: 1 });

    expect(await client.whoami()).toMatchObject({ partition: 'shop', capabilities: ['crypto:*'] });

    const key = await client.createKey({ name: 'orders', type: 'aes256-gcm', exportable: true });
    expect(key).toMatchObject({ name: 'orders', latestVersion: 1 });

    const encrypted = await client.encrypt({
      key: 'orders',
      plaintext: 'remote secret',
      aad: 'row',
    });
    expect(encrypted.version).toBe(1);
    expect(
      await client.decrypt({ key: 'orders', ciphertext: encrypted.ciphertext, aad: 'row' }),
    ).toMatchObject({ plaintext: 'remote secret' });

    await client.rotateKey('orders');
    const rewrapped = await client.rewrap({
      key: 'orders',
      ciphertext: encrypted.ciphertext,
      aad: 'row',
    });
    expect(rewrapped.version).toBe(2);

    const dataKey = await client.generateDataKey({ key: 'orders' });
    expect(dataKey).toMatchObject({ key: 'orders', version: 2 });
    expect(await client.decrypt({ key: 'orders', ciphertext: dataKey.wrapped })).toMatchObject({
      plaintext: dataKey.plaintext,
    });

    const listing = await client.listKeys({ search: 'ord', page: 1, size: 10 });
    expect(listing.meta.total).toBe(1);
    expect(await client.getKey('orders')).toMatchObject({ latestVersion: 2 });

    const audit = await client.audit({ size: 50, key: 'orders' });
    expect(audit.data.some((row) => row.operation === 'encrypt')).toBe(true);
    expect(audit.meta.total).toBeGreaterThan(0);

    const exported = await client.exportKey('orders');
    expect(exported.material).toBeTypeOf('string');

    await client.updateKeyPolicy('orders', { deletionAllowed: true, minDecryptionVersion: 2 });
    expect(await client.deleteKey('orders')).toEqual({ key: 'orders', deleted: true });

    expect(oidc.issued()).toBe(1);
  });

  it('signs and verifies remotely, and the signature verifies with the kit public key', async () => {
    const oidc = await issuer();
    const { url } = await start(oidc.base);
    const client = createCryptoClient({
      url,
      partition: 'shop',
      token: await oidc.mint({
        capabilities: [
          'crypto:sign:webhook',
          'crypto:verify:webhook',
          'crypto:keys:read',
          'crypto:keys:manage',
        ],
      }),
      retryDelayMs: 1,
    });
    await client.createKey({ name: 'webhook', type: 'ed25519' });
    const signature = await client.sign({ key: 'webhook', message: 'payload' });
    expect(signature.signature.startsWith('agora:sig1:')).toBe(true);
    expect(
      await client.verify({ key: 'webhook', message: 'payload', signature: signature.signature }),
    ).toEqual({
      key: 'webhook',
      valid: true,
    });
    const { jwk } = await client.publicKey('webhook');
    expect(kitVerify(jwk, 'payload', signature.signature)).toBe(true);

    const signer = cryptoServerSigner({ client, key: 'webhook' });
    const remote = await signer.sign(Buffer.from('bytes'));
    expect(await signer.verify(Buffer.from('bytes'), remote)).toBe(true);
    expect(await signer.verify(Buffer.from('other'), remote)).toBe(false);
  });

  it('refuses a token without the capability and surfaces the wire code', async () => {
    const oidc = await issuer();
    const { url } = await start(oidc.base);
    const manager = createCryptoClient({
      url,
      partition: 'shop',
      token: await oidc.mint({ capabilities: ['crypto:keys:manage', 'crypto:keys:read'] }),
      retryDelayMs: 1,
    });
    await manager.createKey({ name: 'orders', type: 'aes256-gcm' });
    const reader = createCryptoClient({
      url,
      partition: 'shop',
      token: await oidc.mint({ capabilities: ['crypto:decrypt:orders'] }),
      retryDelayMs: 1,
    });
    await expect(reader.encrypt({ key: 'orders', plaintext: 'x' })).rejects.toMatchObject({
      status: 403,
      code: 'forbidden',
    });
    await expect(reader.listKeys()).rejects.toMatchObject({ status: 403 });
    const denied = await manager.audit({ size: 10 });
    expect(denied.data.some((row) => row.result === 'denied')).toBe(true);
  });

  it('takes the partition from the token, never from the client’s claim', async () => {
    const oidc = await issuer();
    const { url } = await start(oidc.base);
    const shop = createCryptoClient({
      url,
      partition: 'shop',
      token: await oidc.mint(),
      retryDelayMs: 1,
    });
    await shop.createKey({ name: 'orders', type: 'aes256-gcm' });
    // The same server, a token for another app: its claim header is ignored.
    const billing = createCryptoClient({
      url,
      partition: 'billing',
      token: await oidc.mint({ partition: 'billing' }),
      retryDelayMs: 1,
    });
    expect((await billing.listKeys()).meta.total).toBe(0);
    await expect(billing.getKey('orders')).rejects.toMatchObject({ status: 404 });
    expect((await shop.whoami()).partition).toBe('shop');
  });

  it('refuses another audience and an expired token', async () => {
    const oidc = await issuer();
    const { url } = await start(oidc.base);
    const wrongAudience = createCryptoClient({
      url,
      partition: 'shop',
      token: await oidc.mint({}, { audience: 'urn:agora:config' }),
      retries: 0,
    });
    await expect(wrongAudience.whoami()).rejects.toMatchObject({ status: 401 });
    const expired = createCryptoClient({
      url,
      partition: 'shop',
      token: await oidc.mint({}, { expired: true }),
      retries: 0,
    });
    await expect(expired.whoami()).rejects.toMatchObject({ status: 401 });
  });

  it('resets the token after a 401 and retries with the fresh one', async () => {
    const oidc = await issuer();
    const { url } = await start(oidc.base);
    const fresh = await oidc.mint();
    let token = 'stale';
    let resets = 0;
    const api = createCryptoClient({
      url,
      partition: 'shop',
      token: {
        get: async () => token,
        reset: () => {
          resets += 1;
          token = fresh;
        },
      },
      retries: 1,
      retryDelayMs: 1,
    });
    expect(await api.whoami()).toMatchObject({ partition: 'shop' });
    expect(resets).toBe(1);
  });

  it('gives up on a 403 without retrying', async () => {
    const oidc = await issuer();
    const { url } = await start(oidc.base);
    let calls = 0;
    const api = createCryptoClient({
      url,
      partition: 'shop',
      token: async () => {
        calls += 1;
        return oidc.mint({ capabilities: [] });
      },
      retries: 2,
      retryDelayMs: 1,
    });
    await expect(api.listKeys()).rejects.toBeInstanceOf(CryptoClientError);
    expect(calls).toBe(1);
  });
});

describe('the crypto server as a KMS root', () => {
  it('wraps and unwraps a data key through the server, bound to its purpose', async () => {
    const oidc = await issuer();
    const { url } = await start(oidc.base);
    const client = createCryptoClient({
      url,
      partition: 'shop',
      token: await oidc.mint(),
      retryDelayMs: 1,
    });
    await client.createKey({ name: 'fleet-root', type: 'aes256-gcm' });
    const kms = cryptoServerKms({ client, key: 'fleet-root' });
    const dataKey = Buffer.from('0123456789abcdef0123456789abcdef');
    const wrapped = await kms.wrap(dataKey, { purpose: 'config:secrets' });
    const unwrapped = await kms.unwrap(wrapped, { purpose: 'config:secrets' });
    expect(Buffer.from(unwrapped).equals(dataKey)).toBe(true);
    await expect(kms.unwrap(wrapped, { purpose: 'agent:poppy-connections' })).rejects.toMatchObject(
      {
        status: 400,
      },
    );

    // Rotating the KMS key does not break existing wrapped keys: the ciphertext names its version.
    await client.rotateKey('fleet-root');
    const afterRotation = await kms.wrap(dataKey, { purpose: 'config:secrets' });
    expect(await kms.unwrap(afterRotation, { purpose: 'config:secrets' })).toEqual(dataKey);
    expect(await kms.unwrap(wrapped, { purpose: 'config:secrets' })).toEqual(dataKey);
  });
});
