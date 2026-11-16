---
'@adonis-agora/crypto-core': minor
---

`capabilityAllows` accepts a key-name prefix: a segment ending in `*` after a prefix
(`crypto:decrypt:subject_*`) matches one segment that starts with that prefix (`subject_42`), and
nothing else. A bare `*` keeps its meaning. A token can now be limited to one family of keys,
such as the per-subject keys of `crypto.subjects`.
