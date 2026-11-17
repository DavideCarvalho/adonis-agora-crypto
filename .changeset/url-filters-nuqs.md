---
"@adonis-agora/crypto-dashboard": minor
---

The console's filters now live in the URL, so a view can be shared, bookmarked and reloaded, and back/forward step through it: the app picked in the topbar, the Keys search and page, and the Audit key, operation, result and page. They sit in the hash's query (`#/audit?app=billing&result=denied`); a value at its default is left out, so existing links (including `#/keys?key=<name>`) open as before, and the picked app is kept when you move between pages.
