---
'@adonis-agora/crypto-integrations': minor
---

The server-held config secret seam, for `@adonis-agora/config`.

`configCrypto({ source, key?, keys? })` seals and opens the `{ key, ciphertext }` reference a config
entry stores: `seal(plaintext, entry)` on the control plane (needs only `crypto:encrypt:<key>`),
`open(reference, entry)` in the app (needs only `crypto:decrypt:<key>`), with the entry identity
(`app`, `environment`, `label`, key) bound as AAD so a reference cannot be moved to another entry,
and an allow-list (`keys`, default the sealing key) so a tampered config cannot point the app at
another key its token holds. `isCryptoReference`/`parseReference` let config mask and validate the
value without knowing crypto, and `configCryptoAad(entry)` derives the same AAD on both sides.

Also: `pnpm bench` (`scripts/bench-crypto.mjs`) and the performance page — what each path costs,
whether Adonis encryption blocks the event loop (it does: it is synchronous), and when a worker
thread is worth it.
