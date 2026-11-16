import { TransportError } from '@adonis-agora/crypto-core';
import { describe, expect, it } from 'vitest';
import { defineConfig } from '../../src/define_config.js';
import { envelopeSkipPaths } from '../../src/http/envelope_global.js';
import { httpTransport } from '../../src/transports/http.js';

const reply = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('lazy tenant url', () => {
  it('defineConfig accepts a function and still refuses a relative string', () => {
    expect(() =>
      defineConfig({
        topology: 'tenant',
        tenant: { url: async () => 'https://crypto.test/_crypto', partition: 'a', token: 't' },
      }),
    ).not.toThrow();
    expect(() =>
      defineConfig({ topology: 'tenant', tenant: { url: '/_crypto', partition: 'a', token: 't' } }),
    ).toThrow(/absolute http\(s\) URL or a function/);
  });

  it('transports.http resolves before the first call and moves after a bare 404', async () => {
    const asked: string[] = [];
    let host = 'old.test';
    const url = Object.assign(async () => `https://${host}/_crypto`, {
      refresh: async () => {
        host = 'new.test';
        return `https://${host}/_crypto`;
      },
    });
    const transport = httpTransport({
      url,
      fetch: (async (input: string | URL) => {
        asked.push(String(input));
        return String(input).startsWith('https://old.test')
          ? new Response('Not Found', { status: 404 })
          : reply({ ok: true, result: { partition: 'a' } });
      }) as typeof fetch,
    });
    await expect(transport.call({ operation: 'whoami', input: {}, token: 't' })).resolves.toEqual({
      partition: 'a',
    });
    expect(asked).toEqual([
      'https://old.test/_crypto/v1/transport',
      'https://new.test/_crypto/v1/transport',
    ]);
  });

  it('transports.http does not refresh on an error the control plane explained', async () => {
    let refreshes = 0;
    const url = Object.assign(async () => 'https://one.test/_crypto', {
      refresh: async () => {
        refreshes += 1;
        return 'https://two.test/_crypto';
      },
    });
    const transport = httpTransport({
      url,
      fetch: (async () =>
        reply({ ok: false, error: { code: 'not_found', message: 'no key' } }, 404)) as typeof fetch,
    });
    await expect(
      transport.call({ operation: 'keys.get', input: { name: 'x' }, token: 't' }),
    ).rejects.toBeInstanceOf(TransportError);
    expect(refreshes).toBe(0);
  });

  it('the envelope leaves the resolved crypto server path unsealed', () => {
    const config = defineConfig({
      topology: 'tenant',
      tenant: { url: async () => 'https://crypto.test/vault', partition: 'a', token: 't' },
    });
    expect(envelopeSkipPaths(config)).toEqual(['/_crypto']);
    expect(envelopeSkipPaths(config, 'https://crypto.test/vault')).toEqual(['/_crypto', '/vault']);
  });
});
