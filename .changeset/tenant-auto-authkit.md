---
"@adonis-agora/crypto": minor
---

Zero-config tenant topology: with `@adonis-agora/authkit-client` configured (its `service`), `defineConfig({ topology: 'tenant' })` is enough. The server URL, the token and the partition come from the `'authkit.client'` binding's `tenantOf('urn:agora:crypto')`, detected structurally (no dependency on authkit-client; an older one without `tenantOf` counts as absent). `tenant` and its `url`/`token`/`partition` are now optional; anything explicit wins field by field, and `tenant: { auto: false }` turns the discovery off. Without the binding or the fields, a web process refuses to boot naming the missing fields and both fixes. The new `crypto.tenant-config` doctor check shows where each field came from (`authkit-client (auto)` or `explicit`).
