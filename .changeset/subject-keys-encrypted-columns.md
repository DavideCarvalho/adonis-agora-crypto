---
'@adonis-agora/crypto': minor
---

**Per-subject encryption with local envelopes** (`subjects` in `config/crypto.ts`).

Each subject (a researcher, a user) gets its own deletable `aes256-gcm` key on the crypto server
(`subject_<id>`, created on first write or with `crypto.subjects.create(id)`). Values are encrypted
in the app with AES-256-GCM under a data key; the data key is wrapped by the subject key and stored
in the app's database (`crypto_data_keys`). Unwrapped data keys are cached in memory (LRU + TTL,
`{ maxEntries: 1000, ttlMs: 300000 }` by default, zeroed on eviction), so steady-state reads and
writes make no call to the crypto server. When the server is down, cached subjects keep working and
the others fail with `SubjectKeyError` code `unavailable`. There is never a plaintext fallback.
Works in every topology (standalone, control plane, tenant).

- `crypto.subjects.encrypt / decrypt / encryptJson / decryptJson`. The format is
  `agora:se1:<subject key>:<data key id>:<base64url(iv‖ct‖tag)>`, and the AAD binds the version,
  subject key, data key id and the caller's `aad`.
- `crypto.forgetSubject(id)` (and `crypto:subjects:forget`): crypto-shredding. It deletes the
  subject key, its wrapped data keys and its cached data keys.
- `@encrypted({ subject, json?, legacyPlaintext?, row? })`: an encrypted Lucid column. It encrypts
  in `before:save` and decrypts after `find` / `fetch` (pagination and preloads included). Each
  value is bound to table, column and row id. A value that does not open throws, and so does any
  write path that would skip encryption (`saveQuietly`). `legacyPlaintext` reads not-yet-encrypted
  rows while a migration runs.
- `crypto:subjects:backfill <model>` / `backfillEncryptedColumns(Model, options)`: encrypts a
  table in place in batches by primary key. It is idempotent, resumable (`--from <cursor>`), never
  overwrites a concurrent write, and leaves `updated_at` alone. `--rotate` re-encrypts values whose
  data key was retired by `subjects.rotateDataKey(id)`.
- `crypto:subjects:rewrap-keys` / `subjects.rewrapDataKeys()`: moves wrapped data keys to the
  latest subject-key version after a rotation, without touching the data.
- `memorySubjectKeys()` in `@adonis-agora/crypto/testing`, and `dataKeyStores.lucid()` /
  `dataKeyStores.memory()`.

Hardening from the security review:

- **Typed subjects.** `{ type, id }` or a column `namespace` gives `subject_<type>_<id>`, so researcher 7
  and project 7 never share a key. `requireType: true` refuses bare ids.
- **Moving rows.** A row whose subject or row binding changes is re-sealed on save. Saving it while one
  of its encrypted columns is not loaded throws, because that value would otherwise stay with the old owner.
- **Writes are bound to the row.** `prepare` writes a ciphertext only once, and only for the row's
  current subject and id, so `saveQuietly` after a failed save cannot write a stale value.
- **Database guard.** `encryptedColumnCheck` / `addEncryptedColumnCheck` build a CHECK constraint
  (plaintext and wrong-subject values refused, `NOT VALID` on Postgres during a migration). This
  covers query-builder and raw-SQL writes.
- **`legacyPlaintext`.** It never treats another `agora:` ciphertext as plaintext, accepts a per-row
  function, calls `onLegacyRead`, and is reported by a new `crypto.subjects` doctor check.
- **`onUndecryptable: 'null'`** for listings that may include forgotten subjects.
- **Forget and rotate races.** `forget` leaves a tombstone, so a provision already in flight cannot
  re-cache a forgotten subject's data key. A provision that raced `rotateDataKey` no longer brings
  the retired data key back as current. Concurrent lazy creation of a subject key across processes is safe.
- **`decrypt` subject check.** `decrypt` requires the expected `subject`, or an explicit `anySubject: true`.
- **No plaintext in errors.** `decryptJson` never echoes the plaintext in its error.
- **Key-scoped capabilities.** The service accepts `crypto:keys:read:<key>` and
  `crypto:keys:manage:<key>` (prefix capabilities included), so a web token can be limited to
  subject keys.
- **Backfill.** `onError: 'skip'` / `--skip-errors` records failures without the values. It refuses
  json/jsonb (non-text) columns and other `agora:` ciphertext, reports re-sealed values as `moved`
  (refused without row binding), and keeps `--from` as text.

Also fixed: a standalone config that omitted `topology` (it defaults to standalone) booted with an
empty partition, so every in-process operation failed with "the token names no partition".
