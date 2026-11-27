---
"@adonis-agora/crypto": patch
---

`node ace configure @adonis-agora/crypto --topology=tenant` writes the one-line tenant config (`defineConfig({ topology: 'tenant' })`, with url, token and partition coming from `@adonis-agora/authkit-client`), with the explicit `tenant` block shown as a comment. The tenant boot error now points at `config/authkit_client.ts`, the file where authkit-client's `service` lives (it said `config/authkit.ts`).
