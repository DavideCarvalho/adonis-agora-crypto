# @adonis-agora/crypto-integrations

## 0.3.1

### Patch Changes

- Updated dependencies [[`1d70131`](https://github.com/DavideCarvalho/adonis-agora-crypto/commit/1d70131ca1cbb9f2b95542f3acf25b1faf3f42e0)]:
  - @adonis-agora/crypto@0.6.0
  - @adonis-agora/crypto-core@0.4.0

## 0.3.0

### Minor Changes

- [#14](https://github.com/DavideCarvalho/adonis-agora-crypto/pull/14) [`ef09ac8`](https://github.com/DavideCarvalho/adonis-agora-crypto/commit/ef09ac86208132eba42e25fc6ddac111fe5e964b) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - The tenant side lives in `@adonis-agora/crypto`, like every other Agora lib.
  
  `@adonis-agora/crypto-client` is gone. The typed client, `cryptoServerKms`, `cryptoEnvelope`/
  `cryptoFetch` and `cryptoServerSigner` moved to `@adonis-agora/crypto-core` (the only piece a worker,
  a script or a non-Adonis service needs — it never imports `@adonisjs/core`), and `@adonis-agora/crypto`
  re-exports them. A tenant now installs one package and picks its role with `topology: 'tenant'` in
  `config/crypto.ts`; `services/main` gives the same API in `standalone`, `control-plane` and `tenant`.
  
  `@adonis-agora/crypto-integrations` and `@adonis-agora/crypto-react` import from `crypto`/`crypto-core`,
  never from a separate client package. Docs got the same "Central server" shape as flags (control
  plane, tenant, moving from standalone, end-to-end example). `@adonis-agora/crypto-client` is deprecated
  on npm; its last version keeps working.

### Patch Changes

- Updated dependencies [[`ef09ac8`](https://github.com/DavideCarvalho/adonis-agora-crypto/commit/ef09ac86208132eba42e25fc6ddac111fe5e964b)]:
  - @adonis-agora/crypto@0.5.0
  - @adonis-agora/crypto-core@0.3.0

## 0.2.0

### Minor Changes

- [#12](https://github.com/DavideCarvalho/adonis-agora-crypto/pull/12) [`ab8292a`](https://github.com/DavideCarvalho/adonis-agora-crypto/commit/ab8292a52527a7408d5c4ab36043b0325139b86f) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Auditable opens: an operation can carry `context`.
  
  `decrypt`, `rewrap` and `generateDataKey` accept an optional `context` (`user:42`, `grant:7`, `boot`),
  recorded on the audit row as `metadata.context` — including on refusals, so a probe is traceable. It is
  never encrypted, so it must not hold the plaintext or a secret; a value longer than 200 characters or
  with control characters is refused. `DecryptInput`/`RewrapInput`/`DataKeyInput` gained the field, and
  `crypto:decrypt` gained `--context`.
  
  `configCrypto` sends the entry path (`config:<app>:<environment>:<label>:<key>`) as the context, so the
  crypto audit of a server-held config secret says which entry was opened.

- [#12](https://github.com/DavideCarvalho/adonis-agora-crypto/pull/12) [`ab8292a`](https://github.com/DavideCarvalho/adonis-agora-crypto/commit/ab8292a52527a7408d5c4ab36043b0325139b86f) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - The server-held config secret seam, for `@adonis-agora/config`.
  
  `configCrypto({ source, key?, keys? })` seals and opens the `{ key, ciphertext }` reference a config
  entry stores: `seal(plaintext, entry)` on the control plane (needs only `crypto:encrypt:<key>`),
  `open(reference, entry)` in the app (needs only `crypto:decrypt:<key>`), with the entry identity
  (`app`, `environment`, `label`, key) bound as AAD so a reference cannot be moved to another entry,
  and an allow-list (`keys`, default the sealing key) so a tampered config cannot point the app at
  another key its token holds. `isCryptoReference`/`parseReference` let config mask and validate the
  value without knowing crypto, and `configCryptoAad(entry)` derives the same AAD on both sides.
  
  Also: `pnpm bench` (`scripts/bench-crypto.mjs`) and the performance page — what each path costs,
  whether Adonis encryption blocks the event loop (it does: it is synchronous), and when a worker
  thread is worth it.

- [#12](https://github.com/DavideCarvalho/adonis-agora-crypto/pull/12) [`ab8292a`](https://github.com/DavideCarvalho/adonis-agora-crypto/commit/ab8292a52527a7408d5c4ab36043b0325139b86f) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - `sealedOpenChannel(lib)` — the diagnostics bus channel of a recipient-held open.
  
  The payload's `event` stays `crypto:sealed.open` (product-neutral: the fact, not the emitter), while the
  bus channel names who emitted it, `agora:<lib>:sealed.open`, the same convention authkit uses for
  `agora:authkit:<type>`. Config therefore emits `agora:config:sealed.open` with
  `event: 'crypto:sealed.open'`, and another product that opens shares can emit the same payload under
  its own channel. Docs also spell out the whole structural contract (`{ key, ciphertext }`, the AAD, the
  event shape, the capabilities) so a lib can adopt the seams before the package is on npm.

- [#12](https://github.com/DavideCarvalho/adonis-agora-crypto/pull/12) [`ab8292a`](https://github.com/DavideCarvalho/adonis-agora-crypto/commit/ab8292a52527a7408d5c4ab36043b0325139b86f) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - The audit contract for a recipient-held open.
  
  `sealedOpenEvent({ actor, subject, key, kid, resource, at?, result? })` builds the `crypto:sealed.open`
  payload every app emits when it opens a `sealTo` share: `actor ?? sub` — the same identity rule as the
  crypto server's audit — plus the `kid` that opened it, a resource label, a timestamp and `ok`/`error`.
  An open with no identity throws instead of emitting an anonymous row. Exported from the package root
  and from `/config` (which is what emits it, as `config:sealed.open` + `tenant.onSealedOpen`).
  
  `openWithAudit()` (and `sealedKid()`) in `@adonis-agora/crypto-react` open a share on the device and
  return the value with the `kid` and timestamp the event needs.

### Patch Changes

- Updated dependencies [[`ab8292a`](https://github.com/DavideCarvalho/adonis-agora-crypto/commit/ab8292a52527a7408d5c4ab36043b0325139b86f)]:
  - @adonis-agora/crypto-core@0.2.0
  - @adonis-agora/crypto@0.4.0
  - @adonis-agora/crypto-client@0.2.1
