---
"@adonis-agora/crypto": minor
"@adonis-agora/crypto-core": minor
"@adonis-agora/crypto-dashboard": minor
---

Keys now carry `updatedAt` / `updatedBy` from the moment they are created (equal to `createdAt` /
`createdBy`), so every key shows both timestamps; rotations, policy changes and deletes keep moving
`updatedAt`. Key versions and the audit trail stay append-only (`createdAt` / `at` only). The
console's key detail always shows Created and Updated (`—` when a key never recorded one), the key
list's Created cell carries the full timestamp in its tooltip, and `crypto:keys:list` /
`crypto:keys:show` print the timestamps too. No schema change: the columns already existed.
