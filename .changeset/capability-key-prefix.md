---
'@adonis-agora/crypto-core': minor
---

`capabilityAllows` accepts a key-name prefix. In the key-name segment only (`crypto:<op>:<key>`,
`crypto:keys:<scope>:<key>`), a segment ending in `*` after a prefix (`crypto:decrypt:subject_*`)
matches a key name that starts with that prefix (`subject_42`), and nothing else. Prefixes in other
segments (`crypto:d*:x`, `crypto:keys:m*`) match nothing. A bare `*` keeps its meaning. A token can now be limited to one family of keys,
such as the per-subject keys of `crypto.subjects`.
