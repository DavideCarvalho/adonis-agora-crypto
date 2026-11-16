---
"@adonis-agora/crypto": patch
---

`crypto:subjects:backfill` accepts models exported by name (`export class Note`), not only `export default`. A module with several models takes `--export <name>`.
