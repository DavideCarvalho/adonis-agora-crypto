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
  telescope's trace interceptor and authkit-client's token interceptor stay in the chain). It seals the
  JSON body of a request to an app, identified through telescope's discovery slot
  `Symbol.for('@adonis-agora/discovery')` (`appOf`/`resolve`, read lazily — no import of telescope) and,
  when the slot is absent or does not know the origin, through the static `targets` map. Exact origins
  only; any other origin is untouched and crypto's own `/_crypto` API is never sealed.
- **inbound**: a **server** middleware registered by the provider that opens the envelope before the
  body parser hands the body to the route. `request.body()`, `request.all()` and
  `request.validateUsing()` see the plaintext, and the opened state goes on the shared request context
  (`ctx.agora.envelope`, `{ key, issuedAt, payload }`; `ctx.cryptoEnvelope` stays as a deprecated
  alias). Every decrypt failure is one `400` with no detail leak, and the reason is logged server-side.

Also fixes `requestHeaders`: it called Adonis' `request.headers()` detached from the request, so
`verifyTenant` threw on every real HTTP request and the API answered `401` — the harness's fake request
never reproduced it.
