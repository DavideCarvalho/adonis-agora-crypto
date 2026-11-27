# @adonis-agora/crypto-react

## 1.0.0

### Major Changes

- [#40](https://github.com/DavideCarvalho/adonis-agora-crypto/pull/40) [`c72dc96`](https://github.com/DavideCarvalho/adonis-agora-crypto/commit/c72dc968e997b91eddb9c3b00f014bb8fc6b4ccd) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - 1.0 release candidate: crypto joins the rest of the Agora libraries on the 1.x line. One breaking change: the deprecated `ctx.cryptoEnvelope` alias is gone; read the opened envelope from `ctx.agora.envelope`.

### Patch Changes

- Updated dependencies [[`ede8939`](https://github.com/DavideCarvalho/adonis-agora-crypto/commit/ede8939d298d3a611dc172bb2e0c8b58b971f45f), [`c88b503`](https://github.com/DavideCarvalho/adonis-agora-crypto/commit/c88b503985d874a571c52ba5ee10b05ea32c50a7), [`c72dc96`](https://github.com/DavideCarvalho/adonis-agora-crypto/commit/c72dc968e997b91eddb9c3b00f014bb8fc6b4ccd)]:
  - @adonis-agora/crypto-core@1.0.0

## 1.0.0-rc.0

### Major Changes

- [#40](https://github.com/DavideCarvalho/adonis-agora-crypto/pull/40) [`c72dc96`](https://github.com/DavideCarvalho/adonis-agora-crypto/commit/c72dc968e997b91eddb9c3b00f014bb8fc6b4ccd) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - 1.0 release candidate: crypto joins the rest of the Agora libraries on the 1.x line. One breaking change: the deprecated `ctx.cryptoEnvelope` alias is gone; read the opened envelope from `ctx.agora.envelope`.

### Patch Changes

- Updated dependencies [[`c72dc96`](https://github.com/DavideCarvalho/adonis-agora-crypto/commit/c72dc968e997b91eddb9c3b00f014bb8fc6b4ccd)]:
  - @adonis-agora/crypto-core@1.0.0-rc.0

## 0.1.6

### Patch Changes

- Updated dependencies [[`409e8bd`](https://github.com/DavideCarvalho/adonis-agora-crypto/commit/409e8bd8d77624c36e7341c8ba022187bb0583a9)]:
  - @adonis-agora/crypto-core@0.7.0

## 0.1.5

### Patch Changes

- Updated dependencies [[`c305626`](https://github.com/DavideCarvalho/adonis-agora-crypto/commit/c3056266b0b979d5875165eb736adc7c3336ff33)]:
  - @adonis-agora/crypto-core@0.6.0

## 0.1.4

### Patch Changes

- Updated dependencies [[`f0bd3d6`](https://github.com/DavideCarvalho/adonis-agora-crypto/commit/f0bd3d61431a2a06360d5e4b0c0c2f2f7637849a)]:
  - @adonis-agora/crypto-core@0.5.0

## 0.1.3

### Patch Changes

- [#21](https://github.com/DavideCarvalho/adonis-agora-crypto/pull/21) [`eccec14`](https://github.com/DavideCarvalho/adonis-agora-crypto/commit/eccec14f43987d623ddf727a17449ecc8b7b07c2) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Declare independent versioning on every published crypto package:
  `"agora": { "versioning": "independent" }`.
  
  `agora:doctor`'s "Agora versions line up" check warns when a 0.x Agora package sits next to the 1.x rc
  libs, which is a false positive for these packages: they keep their own 0.x line on purpose. The
  doctor already honours the marker (it is how `@adonis-agora/cms` and `authkit-poppy` opt out); the
  packages just were not declaring it. `crypto-dashboard` already did.
- Updated dependencies [[`eccec14`](https://github.com/DavideCarvalho/adonis-agora-crypto/commit/eccec14f43987d623ddf727a17449ecc8b7b07c2)]:
  - @adonis-agora/crypto-core@0.4.1

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
