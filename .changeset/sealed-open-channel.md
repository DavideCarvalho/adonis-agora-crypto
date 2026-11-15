---
'@adonis-agora/crypto-integrations': minor
---

`sealedOpenChannel(lib)` — the diagnostics bus channel of a recipient-held open.

The payload's `event` stays `crypto:sealed.open` (product-neutral: the fact, not the emitter), while the
bus channel names who emitted it, `agora:<lib>:sealed.open`, the same convention authkit uses for
`agora:authkit:<type>`. Config therefore emits `agora:config:sealed.open` with
`event: 'crypto:sealed.open'`, and another product that opens shares can emit the same payload under
its own channel. Docs also spell out the whole structural contract (`{ key, ciphertext }`, the AAD, the
event shape, the capabilities) so a lib can adopt the seams before the package is on npm.
