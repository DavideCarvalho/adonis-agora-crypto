# @adonis-agora/crypto-react

## 0.1.2

### Patch Changes

- Updated dependencies [[`1d70131`](https://github.com/DavideCarvalho/adonis-agora-crypto/commit/1d70131ca1cbb9f2b95542f3acf25b1faf3f42e0)]:
  - @adonis-agora/crypto-core@0.4.0

## 0.1.1

### Patch Changes

- Updated dependencies [[`ef09ac8`](https://github.com/DavideCarvalho/adonis-agora-crypto/commit/ef09ac86208132eba42e25fc6ddac111fe5e964b)]:
  - @adonis-agora/crypto-core@0.3.0

## 0.1.0

### Minor Changes

- [#12](https://github.com/DavideCarvalho/adonis-agora-crypto/pull/12) [`ab8292a`](https://github.com/DavideCarvalho/adonis-agora-crypto/commit/ab8292a52527a7408d5c4ab36043b0325139b86f) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - The browser/React SDK for the asymmetric half of a share.
  
  `createBrowserIdentity()` gives each person an X25519 key pair; `sealBrowserIdentity(identity,
  passphrase)` keeps the private half sealed (PBKDF2-SHA256 + AES-256-GCM), and only the public JWK is
  stored or registered. `sealTo(recipientPublicKey, payload, { aad })` and `openWith(privateKey,
  sealed, { aad })` are byte-compatible with the Agora crypto kit — a browser-sealed share opens with
  the kit and vice versa (tests cover both directions).
  
  `<CryptoProvider>` + `useCrypto()`/`useSealTo()`/`useOpenWith()`/`usePublicKey()` expose the unlocked
  identity to a React tree, with `unlock`, `create` and `lock`; the app decides when to ask for the
  passphrase and where the sealed document lives (`localStorageIdentityStorage()` included).
  
  Runs on `@noble/curves`, `@noble/hashes` and `@noble/ciphers` (no Node built-ins): a React app, a
  worker or a test.

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
