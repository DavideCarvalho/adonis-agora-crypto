import { describe, expect, it } from 'vitest';
import { CryptoClientError, createCryptoClient, ServerUrl } from '../src/index.js';

/** A fetch that answers per host, recording every URL it was asked for. */
function hosts(answers: Record<string, (path: string) => Response | Error>) {
  const asked: string[] = [];
  const fetchFn = (async (input: string | URL) => {
    const url = new URL(String(input));
    asked.push(url.href);
    const answer = answers[url.host]?.(url.pathname) ?? new TypeError('fetch failed');
    if (answer instanceof Error) throw answer;
    return answer;
  }) as typeof fetch;
  return { asked, fetchFn };
}

const ok = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

describe('lazy server url', () => {
  it('resolves the function once, before the first call', async () => {
    let lookups = 0;
    const url = async () => {
      lookups += 1;
      return 'https://one.test/_crypto/';
    };
    const { asked, fetchFn } = hosts({
      'one.test': () => ok({ partition: 'a', capabilities: [] }),
    });
    const client = createCryptoClient({ url, partition: 'a', token: 't', fetch: fetchFn });
    expect(client.url).toBe('');
    await client.whoami();
    await client.whoami();
    expect(lookups).toBe(1);
    expect(client.url).toBe('https://one.test/_crypto');
    expect(asked).toEqual([
      'https://one.test/_crypto/v1/whoami',
      'https://one.test/_crypto/v1/whoami',
    ]);
  });

  it('refreshes after a connection error and calls the new host', async () => {
    let current = 'https://old.test/_crypto';
    const url = Object.assign(async () => current, {
      refresh: async () => {
        current = 'https://new.test/_crypto';
        return current;
      },
    });
    const { asked, fetchFn } = hosts({
      'new.test': () => ok({ partition: 'a', capabilities: [] }),
    });
    const client = createCryptoClient({
      url,
      partition: 'a',
      token: 't',
      fetch: fetchFn,
      retries: 0,
    });
    await expect(client.whoami()).resolves.toMatchObject({ partition: 'a' });
    expect(asked).toEqual([
      'https://old.test/_crypto/v1/whoami',
      'https://new.test/_crypto/v1/whoami',
    ]);
  });

  it('refreshes on a bare 404 but not on a crypto not_found', async () => {
    let refreshes = 0;
    const url = Object.assign(async () => 'https://one.test/_crypto', {
      refresh: async () => {
        refreshes += 1;
        return 'https://one.test/_crypto';
      },
    });
    const { fetchFn } = hosts({
      'one.test': (path) =>
        path.endsWith('/keys/gone')
          ? new Response(JSON.stringify({ error: 'no key', code: 'not_found' }), { status: 404 })
          : new Response('Not Found', { status: 404 }),
    });
    const client = createCryptoClient({
      url,
      partition: 'a',
      token: 't',
      fetch: fetchFn,
      retries: 0,
    });
    await expect(client.getKey('gone')).rejects.toMatchObject({ code: 'not_found' });
    expect(refreshes).toBe(0);
    const failure = await client.whoami().catch((error: CryptoClientError) => error);
    expect(failure).toBeInstanceOf(CryptoClientError);
    expect(refreshes).toBe(1);
  });

  it('a fixed URL never looks anything up, and a bad result is refused', async () => {
    expect(await new ServerUrl('https://x.test/_crypto').refresh()).toBeUndefined();
    const bad = new ServerUrl(async () => 'ftp://nope');
    await expect(bad.resolve()).rejects.toThrow(/absolute http/);
    // A failed lookup is not cached.
    let calls = 0;
    const flaky = new ServerUrl(async () => {
      calls += 1;
      if (calls === 1) throw new Error('issuer down');
      return 'https://x.test';
    });
    await expect(flaky.resolve()).rejects.toThrow('issuer down');
    await expect(flaky.resolve()).resolves.toBe('https://x.test');
  });
});
