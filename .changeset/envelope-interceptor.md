---
'@adonis-agora/crypto': minor
---

App-to-app encryption by configuration (the "hub" row of the Agora spec).

`config/crypto.ts` gains `envelope`, and the provider installs both halves from that block alone — no
app code and no `start/kernel.ts` edit:

```ts
envelope: {
  key: 'svc-hub',                                   // the shared aes256-gcm key
  targets: { billing: 'https://billing.internal' }, // fallback when discovery is absent
}
```

- **outbound**: an undici interceptor **composed onto** the global dispatcher (never replacing it, so
  telescope's trace interceptor and authkit-client's token interceptor stay in the chain). Node 24's
  `fetch` reads `Symbol.for('undici.globalDispatcher.1')` while Node 26's bundled undici 8 reads `.2`, so
  the provider triggers the dispatcher's lazy install and composes onto every slot that exists, then
  proves it with a probe to a reserved `.invalid` origin — boot fails rather than send plaintext to an
  app it was told to seal. It seals the JSON body of a request to an app, identified through
  telescope's discovery slot `Symbol.for('@adonis-agora/discovery')` (`appOf`/`resolve`, read lazily —
  no import of telescope) and, when the slot is absent or does not know the origin, through the static
  `targets` map. Exact origins only; any other origin is untouched and crypto's own `/_crypto` API is
  never sealed. The seal is asynchronous and a failure is reported through undici's handler, so the
  request fails with the real cause and nothing clear is ever written.
- **inbound**: a **server** middleware registered by the provider that opens the envelope before the
  body parser hands the body to the route. `request.body()`, `request.all()` and
  `request.validateUsing()` see the plaintext, and the opened state goes on the shared request context
  (`ctx.agora.envelope`, `{ key, issuedAt, payload }`; `ctx.cryptoEnvelope` stays as a deprecated
  alias). Every decrypt failure is one `400` with no detail leak, and the reason is logged server-side.

Also fixes `requestHeaders`: it called Adonis' `request.headers()` detached from the request, so
`verifyTenant` threw on every real HTTP request and the API answered `401` — the harness's fake request
never reproduced it.
