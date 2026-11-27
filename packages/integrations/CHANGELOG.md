# @adonis-agora/crypto-integrations

## 1.0.0

### Major Changes

- [#40](https://github.com/DavideCarvalho/adonis-agora-crypto/pull/40) [`c72dc96`](https://github.com/DavideCarvalho/adonis-agora-crypto/commit/c72dc968e997b91eddb9c3b00f014bb8fc6b4ccd) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - 1.0 release candidate: crypto joins the rest of the Agora libraries on the 1.x line. One breaking change: the deprecated `ctx.cryptoEnvelope` alias is gone; read the opened envelope from `ctx.agora.envelope`.

### Patch Changes

- Updated dependencies [[`ede8939`](https://github.com/DavideCarvalho/adonis-agora-crypto/commit/ede8939d298d3a611dc172bb2e0c8b58b971f45f), [`c88b503`](https://github.com/DavideCarvalho/adonis-agora-crypto/commit/c88b503985d874a571c52ba5ee10b05ea32c50a7), [`0107d43`](https://github.com/DavideCarvalho/adonis-agora-crypto/commit/0107d43c1f3d1ad1259dc39db22a104324e914de), [`c72dc96`](https://github.com/DavideCarvalho/adonis-agora-crypto/commit/c72dc968e997b91eddb9c3b00f014bb8fc6b4ccd)]:
  - @adonis-agora/crypto@1.0.0
  - @adonis-agora/crypto-core@1.0.0

## 1.0.0-rc.0

### Major Changes

- [#40](https://github.com/DavideCarvalho/adonis-agora-crypto/pull/40) [`c72dc96`](https://github.com/DavideCarvalho/adonis-agora-crypto/commit/c72dc968e997b91eddb9c3b00f014bb8fc6b4ccd) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - 1.0 release candidate: crypto joins the rest of the Agora libraries on the 1.x line. One breaking change: the deprecated `ctx.cryptoEnvelope` alias is gone; read the opened envelope from `ctx.agora.envelope`.

### Patch Changes

- Updated dependencies [[`c72dc96`](https://github.com/DavideCarvalho/adonis-agora-crypto/commit/c72dc968e997b91eddb9c3b00f014bb8fc6b4ccd)]:
  - @adonis-agora/crypto@1.0.0-rc.0
  - @adonis-agora/crypto-core@1.0.0-rc.0

## 0.4.0

### Minor Changes

- [#39](https://github.com/DavideCarvalho/adonis-agora-crypto/pull/39) [`4104cde`](https://github.com/DavideCarvalho/adonis-agora-crypto/commit/4104cde387b783b9ab7650d46dfe4382d0397f6f) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - New `@adonis-agora/crypto-integrations/collaboration` subpath: `collaborationCodec({ docs, subjects, subject })` (per-subject keys) or `collaborationCodec({ docs, source, key })` (a named key) is a storage codec for `@adonis-agora/collaboration` (`lucidStorage({ codec })`, `withCodec`). Matched documents have their state, version snapshots, comment bodies and anchors sealed; others pass through. The default AAD is `["agora:collab", docName, kind, field, versionId ?? commentId ?? null]`, and binary values are base64'd before sealing, so it reads and writes the same values as a hand-written codec on `crypto.subjects`. Opt-in `envelope` mode (named key only) seals locally under a data key per document (`agora:ce1:`); both formats always open. The codec carries a stack descriptor for telescope. `@adonis-agora/collaboration` is an optional peer: its codec contract is declared structurally, nothing is imported from it.

## 0.3.10

### Patch Changes

- Updated dependencies [[`7f56709`](https://github.com/DavideCarvalho/adonis-agora-crypto/commit/7f567098971e8b2e2d2bf2e568c0c7ce56ad72b5)]:
  - @adonis-agora/crypto@0.13.0

## 0.3.9

### Patch Changes

- [#35](https://github.com/DavideCarvalho/adonis-agora-crypto/pull/35) [`68f3008`](https://github.com/DavideCarvalho/adonis-agora-crypto/commit/68f300876c6a7609fed76e89f915d255f2491a1f) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - The seams describe what they use to telescope's Architecture page: `encryptedTransport` and `encryptedControlPlane` add the crypto server (`durable payloads`, `durable events`) to what the wrapped transport already says, and keep durable's own hints readable through the wrapper; the flags and http envelopes tag their `fetch` (`flags events`, `http envelope`).

## 0.3.8

### Patch Changes

- Updated dependencies [[`409e8bd`](https://github.com/DavideCarvalho/adonis-agora-crypto/commit/409e8bd8d77624c36e7341c8ba022187bb0583a9)]:
  - @adonis-agora/crypto@0.12.0
  - @adonis-agora/crypto-core@0.7.0

## 0.3.7

### Patch Changes

- Updated dependencies [[`c305626`](https://github.com/DavideCarvalho/adonis-agora-crypto/commit/c3056266b0b979d5875165eb736adc7c3336ff33)]:
  - @adonis-agora/crypto@0.11.0
  - @adonis-agora/crypto-core@0.6.0

## 0.3.6

### Patch Changes

- Updated dependencies [[`f0bd3d6`](https://github.com/DavideCarvalho/adonis-agora-crypto/commit/f0bd3d61431a2a06360d5e4b0c0c2f2f7637849a), [`f0bd3d6`](https://github.com/DavideCarvalho/adonis-agora-crypto/commit/f0bd3d61431a2a06360d5e4b0c0c2f2f7637849a)]:
  - @adonis-agora/crypto-core@0.5.0
  - @adonis-agora/crypto@0.10.0

## 0.3.5

### Patch Changes

- [#21](https://github.com/DavideCarvalho/adonis-agora-crypto/pull/21) [`eccec14`](https://github.com/DavideCarvalho/adonis-agora-crypto/commit/eccec14f43987d623ddf727a17449ecc8b7b07c2) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Declare independent versioning on every published crypto package:
  `"agora": { "versioning": "independent" }`.
  
  `agora:doctor`'s "Agora versions line up" check warns when a 0.x Agora package sits next to the 1.x rc
  libs, which is a false positive for these packages: they keep their own 0.x line on purpose. The
  doctor already honours the marker (it is how `@adonis-agora/cms` and `authkit-poppy` opt out); the
  packages just were not declaring it. `crypto-dashboard` already did.
- Updated dependencies [[`eccec14`](https://github.com/DavideCarvalho/adonis-agora-crypto/commit/eccec14f43987d623ddf727a17449ecc8b7b07c2)]:
  - @adonis-agora/crypto@0.9.1
  - @adonis-agora/crypto-core@0.4.1

## 0.3.4

### Patch Changes

- Updated dependencies [[`0ddb3a0`](https://github.com/DavideCarvalho/adonis-agora-crypto/commit/0ddb3a007de5103c9b1497e7eea350b465225506)]:
  - @adonis-agora/crypto@0.9.0

## 0.3.3

### Patch Changes

- Updated dependencies [[`a119031`](https://github.com/DavideCarvalho/adonis-agora-crypto/commit/a11903133a9554ff9de81999512c532ce67b798d)]:
  - @adonis-agora/crypto@0.8.0

## 0.3.2

### Patch Changes

- Updated dependencies [[`30d7526`](https://github.com/DavideCarvalho/adonis-agora-crypto/commit/30d7526874ce338c42fc78576161b11c45ea78d6)]:
  - @adonis-agora/crypto@0.7.0

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
