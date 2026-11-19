# @adonis-agora/crypto-dashboard

## 0.3.5

### Patch Changes

- [#37](https://github.com/DavideCarvalho/adonis-agora-crypto/pull/37) [`51276ce`](https://github.com/DavideCarvalho/adonis-agora-crypto/commit/51276ce20df3ca59294bd32ad9a3a2eb15c26ac9) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Scope picker: the button is named "App: Hub" / "Organization: Globex" for screen readers, search also matches the hint, the highlight stays on a real option when the list shrinks, and focus returns to the button after a pick.

## 0.3.4

### Patch Changes

- [#36](https://github.com/DavideCarvalho/adonis-agora-crypto/pull/36) [`7aafd49`](https://github.com/DavideCarvalho/adonis-agora-crypto/commit/7aafd4999ac4499b1db23bd3482bdbc5f7fd57b1) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Console: the topbar App picker is now the shared kit picker (`ScopeMenu`, a fixed `ScopeChip` when there is only one app), the same one telescope uses; the pick still lives in `?app=` in the hash. Going to another console (switcher, ⌘K, search results, sidebar links) keeps this page's `?app=` and `?tenant=`. The console kit copy is updated from the canonical kit.

## 0.3.3

### Patch Changes

- [#33](https://github.com/DavideCarvalho/adonis-agora-crypto/pull/33) [`686b789`](https://github.com/DavideCarvalho/adonis-agora-crypto/commit/686b789d10ce76c5615736ee6fdbb4ada8d33a13) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Console: creatable comboboxes keep the typed text when you leave the field, and server-side suggestions no longer wipe what you are typing.

## 0.3.2

### Patch Changes

- [#32](https://github.com/DavideCarvalho/adonis-agora-crypto/pull/32) [`eac3997`](https://github.com/DavideCarvalho/adonis-agora-crypto/commit/eac3997f7054d7c0e3399dbaf232a790338dd906) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Console pickers with autocomplete (the kit's new `ComboSelect`): the topbar app picker, and the Audit page's key and operation filters. The key filter offers the app's keys (searched on the server as you type) and still takes any typed name. The New key dialog lists the key types the server reports in `/meta`.

## 0.3.1

### Patch Changes

- [#30](https://github.com/DavideCarvalho/adonis-agora-crypto/pull/30) [`6239c79`](https://github.com/DavideCarvalho/adonis-agora-crypto/commit/6239c79341ffb97cddf3cc171e260144d43372e1) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Console ⌘K: arrow keys now visibly move the selection. The highlighted item was styled with a bare `data-selected:` (cmdk marks every item `true` or `false`) and with the dialog's own surface color, so moving looked like nothing happened.

## 0.3.0

### Minor Changes

- [#28](https://github.com/DavideCarvalho/adonis-agora-crypto/pull/28) [`409e8bd`](https://github.com/DavideCarvalho/adonis-agora-crypto/commit/409e8bd8d77624c36e7341c8ba022187bb0583a9) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - The audit trail pages by cursor, so a deep page costs the same as the first and no request counts the whole trail.
  
  - `GET /v1/audit` (and the console's `/api/audit`) accept `first`/`after` (or `last`/`before`) and answer `{ data, meta: { nextCursor, prevCursor, hasNext, hasPrev } }`, seeking on `(at, id)` with no `COUNT(*)`. `page`/`size` keep working and keep the offset envelope with its total.
  - `CryptoClient.auditCursor({ size, after, before, ...filters })` walks it from a tenant; `client.audit()` is unchanged.
  - The console's Audit page walks by cursor: Previous/Next, the walked cursors in the URL (`#/audit?after=…`), so back/forward and shared links still work. It no longer shows a row total.
  - Stores gain an optional `seekAudit` (both built-in stores implement it). The in-memory store's `listAudit` now orders ties on `at` by `id`, like the SQL store.
  - New migration `add_crypto_audit_filter_indexes` (published by `configure`): one index per audit filter (key, operation, result, actor) plus `(app, at, id)`, built `CONCURRENTLY` on Postgres. Opt-in: run it once on existing installs (see Getting started).
  - Fix: `node ace add @adonis-agora/crypto` failed while publishing its stubs (no destination, and backticks the stub template could not compile); the config and migration stubs now publish.

## 0.2.0

### Minor Changes

- [#27](https://github.com/DavideCarvalho/adonis-agora-crypto/pull/27) [`48979d0`](https://github.com/DavideCarvalho/adonis-agora-crypto/commit/48979d0b6f9c8cfefbefaab7ac1895aa8a48ecac) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - The console's filters now live in the URL, so a view can be shared, bookmarked and reloaded, and back/forward step through it: the app picked in the topbar, the Keys search and page, and the Audit key, operation, result and page. They sit in the hash's query (`#/audit?app=billing&result=denied`); a value at its default is left out, so existing links (including `#/keys?key=<name>`) open as before, and the picked app is kept when you move between pages.

## 0.1.2

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

## 0.1.1

### Patch Changes

- [#13](https://github.com/DavideCarvalho/adonis-agora-crypto/pull/13) [`10bcb45`](https://github.com/DavideCarvalho/adonis-agora-crypto/commit/10bcb455c9531608f5a870724c9faf6bbe099873) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - ⌘K now navigates: it lists every page of the console's sidebar and every other Agora console you can open ("Go to Workflows", found by "durable" too), matched case- and accent-insensitively, before the console's own commands and the cross-console search hits. ⌘K opens even without a search endpoint, and shows the pages and consoles before anything is typed.
