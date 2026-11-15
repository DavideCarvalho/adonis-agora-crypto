# @adonis-agora/crypto-dashboard

## 0.1.0

### Minor Changes

- [#3](https://github.com/DavideCarvalho/adonis-agora-crypto/pull/3) [`66b13f2`](https://github.com/DavideCarvalho/adonis-agora-crypto/commit/66b13f29efa58016205520efbdf276c6dabde65c) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - The crypto console and the operator tooling.
  
  `@adonis-agora/crypto-dashboard` is the Agora console (copied console kit, teal accent): an overview
  with the keys, versions, operations and refusals of the last 24h, the key list with create/rotate/
  delete, a key page with the policy editor (decryption floor, deletion, export) and every version's
  status, and the audit trail with filters. It is metadata only — no key material, no plaintext, no
  export button.
  
  The server mounts it at the tenant API's path (`/_crypto`, JSON API under `/_crypto/api`), gated by
  `console.authorize`, registers itself in the `agora.consoles` switcher and its ⌘K search, and exposes
  four **metadata-only** dev tools on the agent hub (`crypto_list_keys`, `crypto_get_key`,
  `crypto_list_audit`, `crypto_overview`) — never an encrypt/decrypt/sign/export tool.
  
  CLI: `crypto:keys:list|show|create|rotate|policy|delete|export|reseal`, `crypto:encrypt`,
  `crypto:decrypt` (with `--value-file`/`--stdin` so a secret does not land in the shell history) and
  `crypto:audit`, all through the same service as the console and the API with `cli:<os user>` as the
  actor. `crypto:keys:reseal [--dry-run] [--all]` moves key material to a rotated root key without
  touching keys, versions or ciphertext.
  
  `agora:doctor` gains five checks: the keyring, the store, every key version opening with the current
  root (a lost root is an error, a retired one a warning), the tenant's reachability and token, and the
  console's gate in production.
