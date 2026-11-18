---
'@adonis-agora/crypto-core': patch
'@adonis-agora/crypto': patch
---

`capabilityAllows`: a `*` before the last one now needs a segment to consume, so `crypto:*:*` no longer matches `crypto`. Only the last `*` may match nothing. The other Agora libs use the same rule.
