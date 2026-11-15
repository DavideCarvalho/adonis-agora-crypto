import { describe, expect, it } from 'vitest';
import { CryptoApi } from './crypto-client';

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('CryptoApi fetcher', () => {
  it('calls the fetcher with the global object as `this`', async () => {
    // Chrome's `fetch` throws "Illegal invocation" when called with anything but the global object;
    // a member call (`this.fetcher(...)`) passes the instance, so the client binds it once.
    const seen: unknown[] = [];
    const fetcher = function (this: unknown) {
      seen.push(this);
      return Promise.resolve(response({ apps: [], defaultPartition: 'shop' }));
    } as unknown as typeof fetch;

    await new CryptoApi('/_crypto/api', fetcher).meta();

    expect(seen).toHaveLength(1);
    expect(seen[0]).toBe(globalThis);
  });

  it('still uses a fetcher the caller passes in', async () => {
    const urls: string[] = [];
    const fetcher = ((url: string) => {
      urls.push(url);
      return Promise.resolve(response({ apps: [], defaultPartition: 'shop' }));
    }) as unknown as typeof fetch;

    await new CryptoApi('/_crypto/api', fetcher).meta();

    expect(urls).toEqual(['/_crypto/api/meta']);
  });
});
