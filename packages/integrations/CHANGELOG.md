# @adonis-agora/crypto-integrations

## 0.1.0

### Minor Changes

- [#5](https://github.com/DavideCarvalho/adonis-agora-crypto/pull/5) [`6b141b5`](https://github.com/DavideCarvalho/adonis-agora-crypto/commit/6b141b5b4ca090c39f60d72d0581beec60863504) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - The 0.x integrations package, so the rc libs stay untouched.
  
  - `/authkit`, `/agent`, `/config`: a crypto-kit KMS root backed by the crypto server under each lib's
    key convention (`authkit-root`, `agent-poppy-root`, `config-root`) plus an `agora:doctor` check
    that the key exists, is `aes256-gcm`, and that this process can seal and open with it (missing key,
    wrong type, missing capabilities and a changed root each get their own message and fix).
  - `/durable`: `encryptedTransport` and `encryptedControlPlane` decorators over ready instances —
    task `input`, step `output`/`error`, heartbeat `progress` and control-plane `event` payloads are
    sealed; ids, step names, groups, priorities, attempts, `from`/`runId` and queue metadata stay in
    clear so routing and dedupe are unchanged. `onControl` keeps broker order, and the docs state the
    NestJS interop caveat.
  - `/flags`: an envelope `fetch` for `transports.http` and the posthog/clickhouse sinks.
  - `/http`: an envelope `fetch` for any call (authkit token requests, config tenant fetches) plus the
    receiver middleware re-exports.
  
  Every helper accepts `{ client }` (remote server) or `{ service, partition }` (embedded server), so
  the same integration works in `standalone`, `control-plane` and `tenant`.
