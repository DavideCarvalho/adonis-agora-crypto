---
'@adonis-agora/crypto': minor
'@adonis-agora/crypto-core': minor
---

Control-plane attribution, per-viewer console apps and a lazy tenant URL.

- **Diagnostics events.** With `@adonis-agora/diagnostics` installed, crypto publishes
  `agora:crypto:<event>` (`encrypt`, `decrypt`, `rewrap`, `datakey`, `sign`, `verify`, `hmac`,
  `keys.create|rotate|policy|delete|export`, `denied`, `subjects.forget`, `subjects.cache`), with
  `app` on the envelope set to the partition the operation acted on: the tenant of the verified token
  on a control plane, the app itself when standalone. A tenant publishes only what the control plane
  cannot see (subject data-key cache misses, and the local half of `forget`). Payloads carry the key
  name, outcome, error code, sizes and duration, never plaintext, ciphertext, key material, AAD or
  audit context. Diagnostics is read through its global slot; no new dependency.
- **Console apps per viewer.** `console.authorize` may answer `{ allowed: true, apps: '*' | string[] }`
  (the same shape as the telescope and flags consoles). The picker, every console API call, the ⌘K
  search and the MCP dev tools stay inside the grant; `console.apps` remains the upper bound.
  `authorizeByToken` takes `apps`.
- **Lazy tenant URL.** `tenant.url` and `transports.http({ url })` accept
  `() => Promise<string>` (with an optional `refresh()`), such as authkit-client's
  `controlPlaneUrl(...)`. It is resolved before the first call and in `agora:doctor`, and looked up
  again after a connection error or a bare 404. `createCryptoClient({ url })` in crypto-core takes the
  same, adds `client.resolveUrl()`, and `client.url` is `''` until a lazy URL resolves.
