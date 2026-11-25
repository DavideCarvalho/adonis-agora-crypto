---
"@adonis-agora/crypto": patch
---

Security: list endpoints reject `__proto__`, `constructor` and `prototype` as `filter[...]` names and drop them as query keys, so a query string can't set the prototype of the parsed filter object.
