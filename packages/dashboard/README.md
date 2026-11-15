# @adonis-agora/crypto-dashboard

The console of `@adonis-agora/crypto`: keys, versions, policy and the audit trail, as a React SPA
served by the crypto server (mounted at `/_crypto`, JSON API under `/_crypto/api`).

Built with `vite build` into `dist/spa`; the server package copies it to `dist/assets/spa` at build
time. The Agora console kit is copied verbatim from `_1x/shared/console-kit`; this console's accent
is teal.

Metadata only: no key material, no plaintext, no export button.

Docs: <https://davidecarvalho.github.io/agora/docs/crypto/console>
