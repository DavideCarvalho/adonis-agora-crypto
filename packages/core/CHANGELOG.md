# @adonis-agora/crypto-core

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
