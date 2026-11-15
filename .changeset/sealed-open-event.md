---
'@adonis-agora/crypto-integrations': minor
'@adonis-agora/crypto-react': minor
---

The audit contract for a recipient-held open.

`sealedOpenEvent({ actor, subject, key, kid, resource, at?, result? })` builds the `crypto:sealed.open`
payload every app emits when it opens a `sealTo` share: `actor ?? sub` — the same identity rule as the
crypto server's audit — plus the `kid` that opened it, a resource label, a timestamp and `ok`/`error`.
An open with no identity throws instead of emitting an anonymous row. Exported from the package root
and from `/config` (which is what emits it, as `config:sealed.open` + `tenant.onSealedOpen`).

`openWithAudit()` (and `sealedKid()`) in `@adonis-agora/crypto-react` open a share on the device and
return the value with the `kid` and timestamp the event needs.
