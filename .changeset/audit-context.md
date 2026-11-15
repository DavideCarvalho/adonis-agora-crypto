---
'@adonis-agora/crypto-core': minor
'@adonis-agora/crypto': minor
'@adonis-agora/crypto-integrations': minor
---

Auditable opens: an operation can carry `context`.

`decrypt`, `rewrap` and `generateDataKey` accept an optional `context` (`user:42`, `grant:7`, `boot`),
recorded on the audit row as `metadata.context` — including on refusals, so a probe is traceable. It is
never encrypted, so it must not hold the plaintext or a secret; a value longer than 200 characters or
with control characters is refused. `DecryptInput`/`RewrapInput`/`DataKeyInput` gained the field, and
`crypto:decrypt` gained `--context`.

`configCrypto` sends the entry path (`config:<app>:<environment>:<label>:<key>`) as the context, so the
crypto audit of a server-held config secret says which entry was opened.
