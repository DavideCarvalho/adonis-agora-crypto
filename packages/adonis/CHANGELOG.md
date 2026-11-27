# @adonis-agora/crypto

## 1.1.2

### Patch Changes

- [#49](https://github.com/DavideCarvalho/adonis-agora-crypto/pull/49) [`7c7bddf`](https://github.com/DavideCarvalho/adonis-agora-crypto/commit/7c7bddf4b734eaa7685669cbcea32b378f50233d) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Fix `import '@adonis-agora/crypto'` failing in 1.1.1 with `Cannot find module …/dist/stubs/main.js` under plain Node (a compiled app; apps running through a TypeScript loader resolved it to the `.ts` source and did not notice). The build now compiles `stubs/main.ts` and no longer deletes it when copying the stubs, and `check:package` imports the built main entry with plain Node.

## 1.1.1

### Patch Changes

- [#47](https://github.com/DavideCarvalho/adonis-agora-crypto/pull/47) [`73c437e`](https://github.com/DavideCarvalho/adonis-agora-crypto/commit/73c437ea90a821db7187707de5f7f9937a0bb807) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - `node ace add @adonis-agora/crypto` (and `node ace configure @adonis-agora/crypto`) now runs the configure hook: the main entry exports `configure`, which Adonis looks for there. Before, it only warned "the module does not export the configure hook" and published nothing.
  
  The published `create_crypto_tables` migration now uses `createTableIfNotExists`. `node ace migration:run` boots the provider, which creates the tables first (`autoCreateSchema` is on by default), so a fresh install failed with "table `crypto_keys` already exists".

## 1.1.0

### Minor Changes

- [#44](https://github.com/DavideCarvalho/adonis-agora-crypto/pull/44) [`8790dc5`](https://github.com/DavideCarvalho/adonis-agora-crypto/commit/8790dc56bcf896dbc4ab02b24885e152d446f284) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Zero-config tenant topology: with `@adonis-agora/authkit-client` configured (its `service`), `defineConfig({ topology: 'tenant' })` is enough. The server URL, the token and the partition come from the `'authkit.client'` binding's `tenantOf('urn:agora:crypto')`, detected structurally (no dependency on authkit-client; an older one without `tenantOf` counts as absent). `tenant` and its `url`/`token`/`partition` are now optional; anything explicit wins field by field, and `tenant: { auto: false }` turns the discovery off. Without the binding or the fields, a web process refuses to boot naming the missing fields and both fixes. The new `crypto.tenant-config` doctor check shows where each field came from (`authkit-client (auto)` or `explicit`).

## 1.0.0

### Major Changes

- [#40](https://github.com/DavideCarvalho/adonis-agora-crypto/pull/40) [`c72dc96`](https://github.com/DavideCarvalho/adonis-agora-crypto/commit/c72dc968e997b91eddb9c3b00f014bb8fc6b4ccd) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - 1.0 release candidate: crypto joins the rest of the Agora libraries on the 1.x line. One breaking change: the deprecated `ctx.cryptoEnvelope` alias is gone; read the opened envelope from `ctx.agora.envelope`.

### Minor Changes

- [`ede8939`](https://github.com/DavideCarvalho/adonis-agora-crypto/commit/ede8939d298d3a611dc172bb2e0c8b58b971f45f) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Security: federated console commands are authenticated. Before, anyone who could publish on the app's Redis could rotate, delete or re-policy its keys (flip `exportable` / `deletionAllowed`) with any actor and capabilities, and forge the answers.
  
  **Breaking:** an app's `consoleCommands` must resolve a mode, or its web process fails at boot with the line to add (ace commands are not affected). The console side needs nothing:
  
  - **Crypto, automatic on the console:** the console (which always runs a crypto server) seals every command with its own `aes256-gcm` key `console-crypto` in the federated app's partition, created at boot (`controlPlane.crypto: false` turns that off). The owning app opens it with `consoleCommands.crypto: { cipher }`, a client of the console's crypto server for its partition, with no grant: a crypto server lets an app decrypt with the `console-*` keys of its own partition implicitly (decrypt only, never another partition's; an explicit `crypto:decrypt:console-*` is harmless). The app cannot pick this by itself: it runs its own crypto server, not the console's. `crypto.owns` lets a third-party cipher (KMS, Vault, HSM) recognize its ciphertext format.
  - **authkit app-call tokens, automatic:** with `@adonis-agora/authkit-client` booted (`apps` on the console, `service` on the app), each command carries the console app's app-call token and the app verifies it; what authkit granted the console app on the app (`crypto:console:*`, or finer) caps it. `controlPlane.token: false` / `consoleCommands.verifyTenant: false` turn it off.
  - **Token (explicit):** `controlPlane.token` + `consoleCommands.verifyTenant` (a control plane falls back to its own), sealed to the app's own X25519 `console-commands` key, read from the app's store.
  - **Shared secret:** the same `secret` on both sides (HMAC on every command and answer).
  
  In every mode commands over a minute old and replays are refused, answers are authenticated, and a refused token answers `401`. Also breaking: the default crypto key is renamed `crypto-console` → `console-crypto`; a control plane's `consoleCommands` serves no partition until `partitions` lists them; an app refuses a command without capabilities (403, code `capabilities-required`; the console always sends the viewer's, narrowed to the crypto console set, the whole set when `authorize` does not narrow); `crypto:console:read` / `:write` / `:*` work as aliases on tokens and viewer capabilities (compared literally); refusals name who lacks the capability (the viewer, the console's token, or the app's `consoleCommands.capabilities`); no console command may touch the `console-commands` or crypto-mode key.
  
  **Breaking (console):** the console's own partitions now honor `authorize`'s `capabilities` (before, only federated commands did, so a viewer granted `crypto:keys:read` could still create, rotate, re-policy and delete keys locally). Create, rotate, policy and delete need `crypto:keys:manage` (403 with a clear message), a test the key's operations, a rewrap `crypto:rewrap:<key>`; reading metadata and the audit stays allowed to everyone let in. An `authorize` that returns no `capabilities` keeps the whole console set. `authorize` answers take the shape shared by every Agora console (`{ allowed, apps?, tenants?, capabilities?, access? }`; malformed `capabilities` grant nothing, `access: 'read'` keeps reading only (no key test), `anyAuthorize` keeps the deciding grant); `authorizeByToken` takes the same grant (`access`, `apps`, `tenants`, `capabilities`). `/meta` returns the viewer's `capabilities` and the page disables what the viewer may not do.
  
  New: `encrypt` takes an optional `partition` to seal with another partition's key (HTTP, broker transports, service, `CryptoClient`): encrypt only, with an explicit `crypto:seal:<key>` grant (`crypto:*` does not count), audited in the target partition. Every other operation refuses another partition. Clients report a server that predates it instead of returning an unopenable ciphertext. A missing `console-*` key in the target partition is created there (`aes256-gcm`) by the first seal, audited as a creation by the sealing caller (`metadata.provisionedBy: 'seal'`), so separate apps coordinate console keys by themselves; `sealProvisioning: false` turns that off.
  
  New doctor checks: `crypto.console-commands` (resolved modes, error when unauthenticated) and `crypto.console-commands-key` (deep: keys exist and round-trip).
  
  New: `hasKey({ key })` on every crypto operations surface (in process, `CryptoClient`, the broker transports; `POST /v1/has-key`): whether a key exists in the caller's own partition, with decrypt's authorization (an app's own `console-*` keys need none), `false` when missing, never audited. The console key checks use it instead of a decrypt probe, so a boot no longer writes `decrypt` error rows. In crypto mode an automatic authkit app-call token that cannot be minted no longer blocks a command: it goes crypto-only, with one warning naming the grant, and is retried after 5 minutes.

- [#41](https://github.com/DavideCarvalho/adonis-agora-crypto/pull/41) [`c88b503`](https://github.com/DavideCarvalho/adonis-agora-crypto/commit/c88b503985d874a571c52ba5ee10b05ea32c50a7) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Keys now carry `updatedAt` / `updatedBy` from the moment they are created (equal to `createdAt` /
  `createdBy`), so every key shows both timestamps; rotations, policy changes and deletes keep moving
  `updatedAt`. Key versions and the audit trail stay append-only (`createdAt` / `at` only). The
  console's key detail always shows Created and Updated (`—` when a key never recorded one), the key
  list's Created cell carries the full timestamp in its tooltip, and `crypto:keys:list` /
  `crypto:keys:show` print the timestamps too. No schema change: the columns already existed.

### Patch Changes

- [#42](https://github.com/DavideCarvalho/adonis-agora-crypto/pull/42) [`0107d43`](https://github.com/DavideCarvalho/adonis-agora-crypto/commit/0107d43c1f3d1ad1259dc39db22a104324e914de) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Security: list endpoints reject `__proto__`, `constructor` and `prototype` as `filter[...]` names and drop them as query keys, so a query string can't set the prototype of the parsed filter object.
- Updated dependencies [[`ede8939`](https://github.com/DavideCarvalho/adonis-agora-crypto/commit/ede8939d298d3a611dc172bb2e0c8b58b971f45f), [`c88b503`](https://github.com/DavideCarvalho/adonis-agora-crypto/commit/c88b503985d874a571c52ba5ee10b05ea32c50a7), [`c72dc96`](https://github.com/DavideCarvalho/adonis-agora-crypto/commit/c72dc968e997b91eddb9c3b00f014bb8fc6b4ccd)]:
  - @adonis-agora/crypto-core@1.0.0

## 1.0.0-rc.3

### Minor Changes

- [`ede8939`](https://github.com/DavideCarvalho/adonis-agora-crypto/commit/ede8939d298d3a611dc172bb2e0c8b58b971f45f) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Security: federated console commands are authenticated. Before, anyone who could publish on the app's Redis could rotate, delete or re-policy its keys (flip `exportable` / `deletionAllowed`) with any actor and capabilities, and forge the answers.
  
  **Breaking:** an app's `consoleCommands` must resolve a mode, or its web process fails at boot with the line to add (ace commands are not affected). The console side needs nothing:
  
  - **Crypto, automatic on the console:** the console (which always runs a crypto server) seals every command with its own `aes256-gcm` key `console-crypto` in the federated app's partition, created at boot (`controlPlane.crypto: false` turns that off). The owning app opens it with `consoleCommands.crypto: { cipher }`, a client of the console's crypto server for its partition, with no grant: a crypto server lets an app decrypt with the `console-*` keys of its own partition implicitly (decrypt only, never another partition's; an explicit `crypto:decrypt:console-*` is harmless). The app cannot pick this by itself: it runs its own crypto server, not the console's. `crypto.owns` lets a third-party cipher (KMS, Vault, HSM) recognize its ciphertext format.
  - **authkit app-call tokens, automatic:** with `@adonis-agora/authkit-client` booted (`apps` on the console, `service` on the app), each command carries the console app's app-call token and the app verifies it; what authkit granted the console app on the app (`crypto:console:*`, or finer) caps it. `controlPlane.token: false` / `consoleCommands.verifyTenant: false` turn it off.
  - **Token (explicit):** `controlPlane.token` + `consoleCommands.verifyTenant` (a control plane falls back to its own), sealed to the app's own X25519 `console-commands` key, read from the app's store.
  - **Shared secret:** the same `secret` on both sides (HMAC on every command and answer).
  
  In every mode commands over a minute old and replays are refused, answers are authenticated, and a refused token answers `401`. Also breaking: the default crypto key is renamed `crypto-console` → `console-crypto`; a control plane's `consoleCommands` serves no partition until `partitions` lists them; an app refuses a command without capabilities (403, code `capabilities-required`; the console always sends the viewer's, narrowed to the crypto console set, the whole set when `authorize` does not narrow); `crypto:console:read` / `:write` / `:*` work as aliases on tokens and viewer capabilities (compared literally); refusals name who lacks the capability (the viewer, the console's token, or the app's `consoleCommands.capabilities`); no console command may touch the `console-commands` or crypto-mode key.
  
  **Breaking (console):** the console's own partitions now honor `authorize`'s `capabilities` (before, only federated commands did, so a viewer granted `crypto:keys:read` could still create, rotate, re-policy and delete keys locally). Create, rotate, policy and delete need `crypto:keys:manage` (403 with a clear message), a test the key's operations, a rewrap `crypto:rewrap:<key>`; reading metadata and the audit stays allowed to everyone let in. An `authorize` that returns no `capabilities` keeps the whole console set. `authorize` answers take the shape shared by every Agora console (`{ allowed, apps?, tenants?, capabilities?, access? }`; malformed `capabilities` grant nothing, `access: 'read'` keeps reading only (no key test), `anyAuthorize` keeps the deciding grant); `authorizeByToken` takes the same grant (`access`, `apps`, `tenants`, `capabilities`). `/meta` returns the viewer's `capabilities` and the page disables what the viewer may not do.
  
  New: `encrypt` takes an optional `partition` to seal with another partition's key (HTTP, broker transports, service, `CryptoClient`): encrypt only, with an explicit `crypto:seal:<key>` grant (`crypto:*` does not count), audited in the target partition. Every other operation refuses another partition. Clients report a server that predates it instead of returning an unopenable ciphertext. A missing `console-*` key in the target partition is created there (`aes256-gcm`) by the first seal, audited as a creation by the sealing caller (`metadata.provisionedBy: 'seal'`), so separate apps coordinate console keys by themselves; `sealProvisioning: false` turns that off.
  
  New doctor checks: `crypto.console-commands` (resolved modes, error when unauthenticated) and `crypto.console-commands-key` (deep: keys exist and round-trip).
  
  New: `hasKey({ key })` on every crypto operations surface (in process, `CryptoClient`, the broker transports; `POST /v1/has-key`): whether a key exists in the caller's own partition, with decrypt's authorization (an app's own `console-*` keys need none), `false` when missing, never audited. The console key checks use it instead of a decrypt probe, so a boot no longer writes `decrypt` error rows. In crypto mode an automatic authkit app-call token that cannot be minted no longer blocks a command: it goes crypto-only, with one warning naming the grant, and is retried after 5 minutes.

### Patch Changes

- Updated dependencies [[`ede8939`](https://github.com/DavideCarvalho/adonis-agora-crypto/commit/ede8939d298d3a611dc172bb2e0c8b58b971f45f)]:
  - @adonis-agora/crypto-core@1.0.0-rc.2

## 1.0.0-rc.2

### Patch Changes

- [#42](https://github.com/DavideCarvalho/adonis-agora-crypto/pull/42) [`0107d43`](https://github.com/DavideCarvalho/adonis-agora-crypto/commit/0107d43c1f3d1ad1259dc39db22a104324e914de) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Security: list endpoints reject `__proto__`, `constructor` and `prototype` as `filter[...]` names and drop them as query keys, so a query string can't set the prototype of the parsed filter object.

## 1.0.0-rc.1

### Minor Changes

- [#41](https://github.com/DavideCarvalho/adonis-agora-crypto/pull/41) [`c88b503`](https://github.com/DavideCarvalho/adonis-agora-crypto/commit/c88b503985d874a571c52ba5ee10b05ea32c50a7) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Keys now carry `updatedAt` / `updatedBy` from the moment they are created (equal to `createdAt` /
  `createdBy`), so every key shows both timestamps; rotations, policy changes and deletes keep moving
  `updatedAt`. Key versions and the audit trail stay append-only (`createdAt` / `at` only). The
  console's key detail always shows Created and Updated (`—` when a key never recorded one), the key
  list's Created cell carries the full timestamp in its tooltip, and `crypto:keys:list` /
  `crypto:keys:show` print the timestamps too. No schema change: the columns already existed.

### Patch Changes

- Updated dependencies [[`c88b503`](https://github.com/DavideCarvalho/adonis-agora-crypto/commit/c88b503985d874a571c52ba5ee10b05ea32c50a7)]:
  - @adonis-agora/crypto-core@1.0.0-rc.1

## 1.0.0-rc.0

### Major Changes

- [#40](https://github.com/DavideCarvalho/adonis-agora-crypto/pull/40) [`c72dc96`](https://github.com/DavideCarvalho/adonis-agora-crypto/commit/c72dc968e997b91eddb9c3b00f014bb8fc6b4ccd) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - 1.0 release candidate: crypto joins the rest of the Agora libraries on the 1.x line. One breaking change: the deprecated `ctx.cryptoEnvelope` alias is gone; read the opened envelope from `ctx.agora.envelope`.

### Patch Changes

- Updated dependencies [[`c72dc96`](https://github.com/DavideCarvalho/adonis-agora-crypto/commit/c72dc968e997b91eddb9c3b00f014bb8fc6b4ccd)]:
  - @adonis-agora/crypto-core@1.0.0-rc.0

## 0.13.0

### Minor Changes

- [#38](https://github.com/DavideCarvalho/adonis-agora-crypto/pull/38) [`7f56709`](https://github.com/DavideCarvalho/adonis-agora-crypto/commit/7f567098971e8b2e2d2bf2e568c0c7ce56ad72b5) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Federated console. An app that runs crypto standalone (its own store and root key) can appear in another app's console: the console lists it in `console.federatedApps`, reads its key metadata, versions and audit straight from its tables (never the `material` column: a new `metadataOnly` Lucid store), and sends every key operation (create, rotate, policy, delete, test, rewrap; never export) to the app over Redis. The owning app opts in with `consoleCommands` (`actions`, `capabilities`) and runs each operation through its own service and audit, with the other console's viewer as the actor and `console:<appLabel>` as the client; the console's `authorize` may narrow it with a new `capabilities` field. New routes: `GET /api/apps`, `POST /api/keys/:name/test` (a probe round trip, audited, no plaintext), `POST /api/keys/:name/rewrap`. The App picker shows a federated badge and notice, a Test button on the key page, and a read-only federated app disables the key operations.

## 0.12.6

### Patch Changes

- [#36](https://github.com/DavideCarvalho/adonis-agora-crypto/pull/36) [`7aafd49`](https://github.com/DavideCarvalho/adonis-agora-crypto/commit/7aafd4999ac4499b1db23bd3482bdbc5f7fd57b1) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Console: the topbar App picker is now the shared kit picker (`ScopeMenu`, a fixed `ScopeChip` when there is only one app), the same one telescope uses; the pick still lives in `?app=` in the hash. Going to another console (switcher, ⌘K, search results, sidebar links) keeps this page's `?app=` and `?tenant=`. The console kit copy is updated from the canonical kit.

## 0.12.5

### Patch Changes

- [#34](https://github.com/DavideCarvalho/adonis-agora-crypto/pull/34) [`20970e7`](https://github.com/DavideCarvalho/adonis-agora-crypto/commit/20970e751ec9291ba284894aff25f5f3c8b4ac4c) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - The key and data key stores, the broker transports (when handed an `@adonisjs/redis` connection) and `cryptoServerKms` now describe the infrastructure they use (`Symbol.for('@adonis-agora/stack')`), and the `defineConfig` result describes the default Lucid stores, so telescope's Architecture page shows "crypto: keys → PostgreSQL" without any app code.
- Updated dependencies [[`20970e7`](https://github.com/DavideCarvalho/adonis-agora-crypto/commit/20970e751ec9291ba284894aff25f5f3c8b4ac4c)]:
  - @adonis-agora/crypto-core@0.7.2

## 0.12.4

### Patch Changes

- [#33](https://github.com/DavideCarvalho/adonis-agora-crypto/pull/33) [`686b789`](https://github.com/DavideCarvalho/adonis-agora-crypto/commit/686b789d10ce76c5615736ee6fdbb4ada8d33a13) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Console: creatable comboboxes keep the typed text when you leave the field, and server-side suggestions no longer wipe what you are typing.

## 0.12.3

### Patch Changes

- [#32](https://github.com/DavideCarvalho/adonis-agora-crypto/pull/32) [`eac3997`](https://github.com/DavideCarvalho/adonis-agora-crypto/commit/eac3997f7054d7c0e3399dbaf232a790338dd906) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Console pickers with autocomplete (the kit's new `ComboSelect`): the topbar app picker, and the Audit page's key and operation filters. The key filter offers the app's keys (searched on the server as you type) and still takes any typed name. The New key dialog lists the key types the server reports in `/meta`.

## 0.12.2

### Patch Changes

- [#31](https://github.com/DavideCarvalho/adonis-agora-crypto/pull/31) [`dba00e2`](https://github.com/DavideCarvalho/adonis-agora-crypto/commit/dba00e2daf27ebac2f66fa62c2eb8a1b9c6befa1) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - `capabilityAllows`: a `*` before the last one now needs a segment to consume, so `crypto:*:*` no longer matches `crypto`. Only the last `*` may match nothing. The other Agora libs use the same rule.
- Updated dependencies [[`dba00e2`](https://github.com/DavideCarvalho/adonis-agora-crypto/commit/dba00e2daf27ebac2f66fa62c2eb8a1b9c6befa1)]:
  - @adonis-agora/crypto-core@0.7.1

## 0.12.1

### Patch Changes

- [#30](https://github.com/DavideCarvalho/adonis-agora-crypto/pull/30) [`6239c79`](https://github.com/DavideCarvalho/adonis-agora-crypto/commit/6239c79341ffb97cddf3cc171e260144d43372e1) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Console ⌘K: arrow keys now visibly move the selection. The highlighted item was styled with a bare `data-selected:` (cmdk marks every item `true` or `false`) and with the dialog's own surface color, so moving looked like nothing happened.

## 0.12.0

### Minor Changes

- [#28](https://github.com/DavideCarvalho/adonis-agora-crypto/pull/28) [`409e8bd`](https://github.com/DavideCarvalho/adonis-agora-crypto/commit/409e8bd8d77624c36e7341c8ba022187bb0583a9) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - The audit trail pages by cursor, so a deep page costs the same as the first and no request counts the whole trail.
  
  - `GET /v1/audit` (and the console's `/api/audit`) accept `first`/`after` (or `last`/`before`) and answer `{ data, meta: { nextCursor, prevCursor, hasNext, hasPrev } }`, seeking on `(at, id)` with no `COUNT(*)`. `page`/`size` keep working and keep the offset envelope with its total.
  - `CryptoClient.auditCursor({ size, after, before, ...filters })` walks it from a tenant; `client.audit()` is unchanged.
  - The console's Audit page walks by cursor: Previous/Next, the walked cursors in the URL (`#/audit?after=…`), so back/forward and shared links still work. It no longer shows a row total.
  - Stores gain an optional `seekAudit` (both built-in stores implement it). The in-memory store's `listAudit` now orders ties on `at` by `id`, like the SQL store.
  - New migration `add_crypto_audit_filter_indexes` (published by `configure`): one index per audit filter (key, operation, result, actor) plus `(app, at, id)`, built `CONCURRENTLY` on Postgres. Opt-in: run it once on existing installs (see Getting started).
  - Fix: `node ace add @adonis-agora/crypto` failed while publishing its stubs (no destination, and backticks the stub template could not compile); the config and migration stubs now publish.

### Patch Changes

- Updated dependencies [[`409e8bd`](https://github.com/DavideCarvalho/adonis-agora-crypto/commit/409e8bd8d77624c36e7341c8ba022187bb0583a9)]:
  - @adonis-agora/crypto-core@0.7.0

## 0.11.3

### Patch Changes

- [#29](https://github.com/DavideCarvalho/adonis-agora-crypto/pull/29) [`d20ceb5`](https://github.com/DavideCarvalho/adonis-agora-crypto/commit/d20ceb5749a675155f9d66a82715904b6ff3ba99) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Ships the console with its filters in the URL (copy the link to share a filtered view). The console is bundled into this package at build time, so it needs its own release to reach apps.

## 0.11.2

### Patch Changes

- [#26](https://github.com/DavideCarvalho/adonis-agora-crypto/pull/26) [`e6ea148`](https://github.com/DavideCarvalho/adonis-agora-crypto/commit/e6ea14854482bee7ea5e5bfcd2cee4daf3c1052e) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - `crypto:subjects:backfill` accepts models exported by name (`export class Note`), not only `export default`. A module with several models takes `--export <name>`.

## 0.11.1

### Patch Changes

- [#25](https://github.com/DavideCarvalho/adonis-agora-crypto/pull/25) [`b62097b`](https://github.com/DavideCarvalho/adonis-agora-crypto/commit/b62097b081fa9c76ad71a73b011bccc27300b94f) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - `legacyPlaintext` and the subjects backfill now refuse only the library's own value tags (`agora:se1:`, `agora:ct1:`, `agora:v1:`, `agora:pk1:`, `agora:sig1:`, in any case) instead of any value starting with `agora:`. Plain text such as "Agora: …" is read as legacy plaintext and encrypted by the backfill; `AGORA:SE1:…` is still refused. New exports: `AGORA_VALUE_TAGS`, `hasAgoraValueTag`.

## 0.11.0

### Minor Changes

- [#24](https://github.com/DavideCarvalho/adonis-agora-crypto/pull/24) [`c305626`](https://github.com/DavideCarvalho/adonis-agora-crypto/commit/c3056266b0b979d5875165eb736adc7c3336ff33) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Control-plane attribution, per-viewer console apps and a lazy tenant URL.
  
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

### Patch Changes

- Updated dependencies [[`c305626`](https://github.com/DavideCarvalho/adonis-agora-crypto/commit/c3056266b0b979d5875165eb736adc7c3336ff33)]:
  - @adonis-agora/crypto-core@0.6.0

## 0.10.0

### Minor Changes

- [#23](https://github.com/DavideCarvalho/adonis-agora-crypto/pull/23) [`f0bd3d6`](https://github.com/DavideCarvalho/adonis-agora-crypto/commit/f0bd3d61431a2a06360d5e4b0c0c2f2f7637849a) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - **Per-subject encryption with local envelopes** (`subjects` in `config/crypto.ts`).
  
  Each subject (a researcher, a user) gets its own deletable `aes256-gcm` key on the crypto server
  (`subject_<id>`, created on first write or with `crypto.subjects.create(id)`). Values are encrypted
  in the app with AES-256-GCM under a data key; the data key is wrapped by the subject key and stored
  in the app's database (`crypto_data_keys`). Unwrapped data keys are cached in memory (LRU + TTL,
  `{ maxEntries: 1000, ttlMs: 300000 }` by default, zeroed on eviction), so steady-state reads and
  writes make no call to the crypto server. When the server is down, cached subjects keep working and
  the others fail with `SubjectKeyError` code `unavailable`. There is never a plaintext fallback.
  Works in every topology (standalone, control plane, tenant).
  
  - `crypto.subjects.encrypt / decrypt / encryptJson / decryptJson`. The format is
    `agora:se1:<subject key>:<data key id>:<base64url(iv‖ct‖tag)>`, and the AAD binds the version,
    subject key, data key id and the caller's `aad`.
  - `crypto.forgetSubject(id)` (and `crypto:subjects:forget`): crypto-shredding. It deletes the
    subject key, its wrapped data keys and its cached data keys.
  - `@encrypted({ subject, json?, legacyPlaintext?, row? })`: an encrypted Lucid column. It encrypts
    in `before:save` and decrypts after `find` / `fetch` (pagination and preloads included). Each
    value is bound to table, column and row id. A value that does not open throws, and so does any
    write path that would skip encryption (`saveQuietly`). `legacyPlaintext` reads not-yet-encrypted
    rows while a migration runs.
  - `crypto:subjects:backfill <model>` / `backfillEncryptedColumns(Model, options)`: encrypts a
    table in place in batches by primary key. It is idempotent, resumable (`--from <cursor>`), never
    overwrites a concurrent write, and leaves `updated_at` alone. `--rotate` re-encrypts values whose
    data key was retired by `subjects.rotateDataKey(id)`.
  - `crypto:subjects:rewrap-keys` / `subjects.rewrapDataKeys()`: moves wrapped data keys to the
    latest subject-key version after a rotation, without touching the data.
  - `memorySubjectKeys()` in `@adonis-agora/crypto/testing`, and `dataKeyStores.lucid()` /
    `dataKeyStores.memory()`.
  
  Hardening from the security review:
  
  - **Typed subjects.** `{ type, id }` or a column `namespace` gives `subject_<type>_<id>`, so researcher 7
    and project 7 never share a key. `requireType` defaults to `true` (bare ids are refused). With
    `false`, a bare string id containing `_` is still refused.
  - **Moving rows.** A row whose subject or row binding changes is re-sealed on save. Saving it while one
    of its encrypted columns is not loaded throws, because that value would otherwise stay with the old owner.
  - **Writes are bound to the row.** `prepare` writes a ciphertext only once, and only for the row's
    current subject and id, so `saveQuietly` after a failed save cannot write a stale value.
  - **Database guard.** `encryptedColumnCheck` / `addEncryptedColumnCheck` build a CHECK constraint
    (`NOT VALID` on Postgres during a migration) that covers query-builder and raw-SQL writes:
    - plaintext and wrong-subject values are refused, and so is a value on a row with a NULL subject;
    - the prefix comparison is exact-case in every dialect;
    - table names can be schema-qualified;
    - `using` follows the app's prefix and refuses a custom `keyName`.
  - **`legacyPlaintext`.** It never treats another `agora:` ciphertext (any letter case) as plaintext, accepts a per-row
    function, calls `onLegacyRead`, and is reported by a new `crypto.subjects` doctor check.
  - **`onUndecryptable: 'null'`** for listings that include forgotten subjects. It covers forgotten
    subjects only; nulling `invalid` values needs `{ null: ['forgotten', 'invalid'] }`.
    `onUndecryptableError` reports every failure. A nulled attribute cannot be saved back as null.
  - **Forget and rotate races.** `forget` leaves a tombstone, so a provision already in flight cannot
    re-cache a forgotten subject's data key. A cold write waits for an in-flight `rotateDataKey`, and
    the current data key is cleared again once the retirement lands. Concurrent lazy creation of a subject key across processes is safe.
  - **`decrypt` subject check.** `decrypt` requires the expected `subject`, or an explicit `anySubject: true`.
  - **No plaintext in errors.** `decryptJson` never echoes the plaintext in its error.
  - **Key-scoped capabilities.** The service accepts `crypto:keys:read:<key>` and
    `crypto:keys:manage:<key>` (prefix capabilities included), so a web token can be limited to
    subject keys.
  - **Backfill.**
    - `onError: 'skip'` / `--skip-errors` skips only `invalid` / `forgotten` values, and records them
      without the values.
    - It refuses json/jsonb (non-text) columns and other `agora:` ciphertext.
    - Values sealed for another subject are reported as `moved` and re-sealed only with
      `adoptMoved` / `--adopt-moved` (refused without row binding).
    - `--from` stays text.
  
  Also fixed: a standalone config that omitted `topology` (it defaults to standalone) booted with an
  empty partition, so every in-process operation failed with "the token names no partition".

### Patch Changes

- Updated dependencies [[`f0bd3d6`](https://github.com/DavideCarvalho/adonis-agora-crypto/commit/f0bd3d61431a2a06360d5e4b0c0c2f2f7637849a)]:
  - @adonis-agora/crypto-core@0.5.0

## 0.9.2

### Patch Changes

- [#22](https://github.com/DavideCarvalho/adonis-agora-crypto/pull/22) [`7523a85`](https://github.com/DavideCarvalho/adonis-agora-crypto/commit/7523a8584e2fff63912c444dad4b911e5531719c) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Three fixes found while building the Agora hub.
  
  **The console mounted two page routes.** It registered `/<path>` **and** `/<path>/`; AdonisJS
  normalizes the trailing slash, so those are the same route and the app died at boot with
  `Duplicate route found. "GET: /<path>"`. One route is registered now (a request to `/<path>/` still
  reaches it, because the router normalizes the URL).
  
  **The console SPA threw "Illegal invocation" in Chrome.** Its API client stored `fetch` and called it
  as `this.fetcher(...)`, which passes the instance as `this`; Chrome's `fetch` only accepts the global
  object, so the console rendered an error while the API itself was fine (Node ignores `this`, which
  is why tests never saw it). The fetcher is bound to `globalThis` once, and the console switcher's
  `fetch` is explicitly `globalThis.fetch`.
  
  **`schema` was accepted and ignored.** `inSchema` only rewrote the table names of another package's
  tables (`config_versions`, `config_audit` — a copy that was never pointed at crypto's own), so the
  `crypto_*` DDL and queries went to `public` whatever `schema` said. It now rewrites `crypto_keys`,
  `crypto_key_versions` and `crypto_audit` in both DDL and queries, inside transactions too. Covered by
  a real-Postgres test (CI gets a Postgres service) that creates a non-default schema, forces
  `search_path` away from it, and checks the tables, the key operations and the audit trail all land
  there.

## 0.9.1

### Patch Changes

- [#21](https://github.com/DavideCarvalho/adonis-agora-crypto/pull/21) [`eccec14`](https://github.com/DavideCarvalho/adonis-agora-crypto/commit/eccec14f43987d623ddf727a17449ecc8b7b07c2) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Declare independent versioning on every published crypto package:
  `"agora": { "versioning": "independent" }`.
  
  `agora:doctor`'s "Agora versions line up" check warns when a 0.x Agora package sits next to the 1.x rc
  libs, which is a false positive for these packages: they keep their own 0.x line on purpose. The
  doctor already honours the marker (it is how `@adonis-agora/cms` and `authkit-poppy` opt out); the
  packages just were not declaring it. `crypto-dashboard` already did.
- Updated dependencies [[`eccec14`](https://github.com/DavideCarvalho/adonis-agora-crypto/commit/eccec14f43987d623ddf727a17449ecc8b7b07c2)]:
  - @adonis-agora/crypto-core@0.4.1

## 0.9.0

### Minor Changes

- [#20](https://github.com/DavideCarvalho/adonis-agora-crypto/pull/20) [`0ddb3a0`](https://github.com/DavideCarvalho/adonis-agora-crypto/commit/0ddb3a007de5103c9b1497e7eea350b465225506) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - App-to-app encryption by configuration (the "hub" row of the Agora spec).
  
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

## 0.8.0

### Minor Changes

- [#19](https://github.com/DavideCarvalho/adonis-agora-crypto/pull/19) [`a119031`](https://github.com/DavideCarvalho/adonis-agora-crypto/commit/a11903133a9554ff9de81999512c532ce67b798d) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Durable as a transport driver.
  
  `transports.durable({ engine })` — or `{ gateway }` on a store-less durable tenant pod — sends the
  same call envelope as the other drivers and takes the **run result** as the reply, because durable's
  `start()` resolves with it: one line, no reply queue and no polling. `handleTransportCall(message)` is
  the server half: the same verify → dedupe → run path as `POST /_crypto/v1/transport`, so the control
  plane drops one file in `app/workflows/` (documented in `docs/transports.mdx`) and reuses its existing
  `verifyTenant`. `localStep` in the workflow body keeps the operation replay-safe.
  
  `tenant.transport` now accepts a broker driver directly (`transports.redis(...)`, `transports.bullmq(...)`,
  `transports.queue(...)`, `transports.durable(...)`): the shared envelope adapter is applied for you, so
  the documented config is the config that type-checks. `transports` is also exported from the package
  root, where the docs import it from.
  
  A failed run surfaces as `TransportError('unavailable')`; a run that never settles is a
  `TransportError('timeout')` (default `15000ms`, a workflow turn rather than a queue hop).

## 0.7.0

### Minor Changes

- [#18](https://github.com/DavideCarvalho/adonis-agora-crypto/pull/18) [`30d7526`](https://github.com/DavideCarvalho/adonis-agora-crypto/commit/30d7526874ce338c42fc78576161b11c45ea78d6) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - BullMQ and queue drivers for the call channel.
  
  `transports.bullmq({ connection, queueName?, prefix?, timeoutMs? })` uses BullMQ's own reply
  (`Queue.add()` + `job.waitUntilFinished(queueEvents)` resolves with the worker's return value), so the
  reply is the job result and a failed job is the dead-letter; bullmq is loaded lazily and
  `queue`/`queueEvents`/`worker` are injectable for tests.
  
  `transports.queue({ connection, dispatch, consume })` carries the request on `@adonisjs/queue` and the
  reply on the queue adapter's Redis (`<prefix>:reply:<id>`) because the Adonis queue has no
  await-result API; the app supplies its job's `dispatch` and its worker's consumer.
  
  Same envelope, token, dedupe, limits and dead-letter as the other drivers, and the same mixed-fleet
  rule: the browser always talks HTTP and the HTTP API stays mounted.

## 0.6.0

### Minor Changes

- [#15](https://github.com/DavideCarvalho/adonis-agora-crypto/pull/15) [`1d70131`](https://github.com/DavideCarvalho/adonis-agora-crypto/commit/1d70131ca1cbb9f2b95542f3acf25b1faf3f42e0) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Pluggable tenant ↔ control-plane transports for the call channel.
  
  `transports.http({ url, fetch?, timeoutMs? })` is the default (an app that configures nothing is
  unchanged) and `transports.redis({ connection, prefix?, timeoutMs? })` is the first broker driver:
  the tenant pushes the envelope on `<prefix>:requests` and blocks on `<prefix>:reply:<id>`, the
  control plane consumes the same list and answers there. Both sides take the same driver via
  `transport` in `config/crypto.ts` (tenant) and on the control-plane config.
  
  Every message carries the tenant token and a message id; `verifyTenant` runs on each message, the
  partition and capabilities come only from the verified token, ids are deduped per partition, payloads
  are capped at 512 KiB, messages older than 5 minutes are refused, calls time out, and poison messages
  are dead-lettered instead of retried forever.
  
  The choice is server-to-server only: the browser (`crypto-react`, the console) always talks HTTP, the
  control plane keeps its HTTP API mounted whatever tenant transport is configured, and a fleet can mix
  HTTP and brokered tenants — covered by a test. `queue`, `bullmq` and `durable` are the next drivers,
  on the `transports.broker(...)` seam the Redis driver implements.

### Patch Changes

- Updated dependencies [[`1d70131`](https://github.com/DavideCarvalho/adonis-agora-crypto/commit/1d70131ca1cbb9f2b95542f3acf25b1faf3f42e0)]:
  - @adonis-agora/crypto-core@0.4.0

## 0.5.0

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
  - @adonis-agora/crypto-core@0.3.0

## 0.4.0

### Minor Changes

- [#12](https://github.com/DavideCarvalho/adonis-agora-crypto/pull/12) [`ab8292a`](https://github.com/DavideCarvalho/adonis-agora-crypto/commit/ab8292a52527a7408d5c4ab36043b0325139b86f) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Auditable opens: an operation can carry `context`.
  
  `decrypt`, `rewrap` and `generateDataKey` accept an optional `context` (`user:42`, `grant:7`, `boot`),
  recorded on the audit row as `metadata.context` — including on refusals, so a probe is traceable. It is
  never encrypted, so it must not hold the plaintext or a secret; a value longer than 200 characters or
  with control characters is refused. `DecryptInput`/`RewrapInput`/`DataKeyInput` gained the field, and
  `crypto:decrypt` gained `--context`.
  
  `configCrypto` sends the entry path (`config:<app>:<environment>:<label>:<key>`) as the context, so the
  crypto audit of a server-held config secret says which entry was opened.

### Patch Changes

- Updated dependencies [[`ab8292a`](https://github.com/DavideCarvalho/adonis-agora-crypto/commit/ab8292a52527a7408d5c4ab36043b0325139b86f)]:
  - @adonis-agora/crypto-core@0.2.0
  - @adonis-agora/crypto-client@0.2.1
