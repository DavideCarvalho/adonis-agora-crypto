---
"@adonis-agora/crypto": patch
---

`legacyPlaintext` and the subjects backfill now refuse only the library's own value tags (`agora:se1:`, `agora:ct1:`, `agora:v1:`, `agora:pk1:`, `agora:sig1:`, in any case) instead of any value starting with `agora:`. Plain text such as "Agora: …" is read as legacy plaintext and encrypted by the backfill; `AGORA:SE1:…` is still refused. New exports: `AGORA_VALUE_TAGS`, `hasAgoraValueTag`.
