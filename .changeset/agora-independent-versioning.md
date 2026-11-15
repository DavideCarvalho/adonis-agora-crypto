---
'@adonis-agora/crypto': patch
'@adonis-agora/crypto-core': patch
'@adonis-agora/crypto-integrations': patch
'@adonis-agora/crypto-react': patch
---

Declare independent versioning on every published crypto package:
`"agora": { "versioning": "independent" }`.

`agora:doctor`'s "Agora versions line up" check warns when a 0.x Agora package sits next to the 1.x rc
libs, which is a false positive for these packages: they keep their own 0.x line on purpose. The
doctor already honours the marker (it is how `@adonis-agora/cms` and `authkit-poppy` opt out); the
packages just were not declaring it. `crypto-dashboard` already did.
