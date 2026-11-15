import { describe, expect, it } from 'vitest';
import { requestHeaders } from '../../src/topology/verify.js';

describe('requestHeaders', () => {
  it('reads headers() through the request, not detached (Adonis reads this.request)', () => {
    const incoming = { authorization: 'Bearer t', 'x-thing': ['a', 'b'] };
    const request = {
      request: { headers: incoming },
      headers() {
        // Exactly Adonis' shape: the method reads `this.request`, so a detached call throws.
        return this.request.headers;
      },
    };

    expect(requestHeaders({ request } as never)).toEqual({
      authorization: 'Bearer t',
      'x-thing': 'a',
    });
  });

  it('also accepts a plain headers object', () => {
    expect(requestHeaders({ request: { headers: { 'X-A': 'b' } } } as never)).toEqual({
      'x-a': 'b',
    });
  });
});
