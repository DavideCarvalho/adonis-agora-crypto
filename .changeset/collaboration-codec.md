---
'@adonis-agora/crypto-integrations': minor
---

New `@adonis-agora/crypto-integrations/collaboration` subpath: `collaborationCodec({ docs, subjects, subject })` (per-subject keys) or `collaborationCodec({ docs, source, key })` (a named key) is a storage codec for `@adonis-agora/collaboration` (`lucidStorage({ codec })`, `withCodec`). Matched documents have their state, version snapshots, comment bodies and anchors sealed; others pass through. The default AAD is `["agora:collab", docName, kind, field, versionId ?? commentId ?? null]`, and binary values are base64'd before sealing, so it reads and writes the same values as a hand-written codec on `crypto.subjects`. Opt-in `envelope` mode (named key only) seals locally under a data key per document (`agora:ce1:`); both formats always open. The codec carries a stack descriptor for telescope. `@adonis-agora/collaboration` is an optional peer: its codec contract is declared structurally, nothing is imported from it.
