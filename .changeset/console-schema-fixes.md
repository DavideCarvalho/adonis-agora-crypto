---
'@adonis-agora/crypto': patch
'@adonis-agora/crypto-dashboard': patch
---

Three fixes found while building the Agora hub.

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
