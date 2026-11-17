# @adonis-agora/crypto-dashboard

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
