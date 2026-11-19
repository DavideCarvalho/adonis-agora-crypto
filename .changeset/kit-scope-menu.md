---
"@adonis-agora/crypto-dashboard": patch
"@adonis-agora/crypto": patch
---

Console: the topbar App picker is now the shared kit picker (`ScopeMenu`, a fixed `ScopeChip` when there is only one app), the same one telescope uses; the pick still lives in `?app=` in the hash. Going to another console (switcher, ⌘K, search results, sidebar links) keeps this page's `?app=` and `?tenant=`. The console kit copy is updated from the canonical kit.
