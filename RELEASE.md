# Releasing

Six packages live in this repo. Every one is published by `.github/workflows/release.yml` on a push
to `master` (changesets versioning + npm trusted publishing, no `NPM_TOKEN`).

| Package | What ships |
| --- | --- |
| `@adonis-agora/crypto-core` | the wire contract, the typed client, envelope fetch, KMS adapter |
| `@adonis-agora/crypto` | the server (commands, stubs, console assets) |
| `@adonis-agora/crypto-dashboard` | the console SPA |
| `@adonis-agora/crypto-integrations` | 0.x seams for authkit, agent, config, durable, flags, http |
| `@adonis-agora/crypto-react` | browser/React X25519 identity and `sealTo`/`openWith` |

## Before the first release

1. **A granular npm token with publish rights** for the `@adonis-agora` scope (2FA bypass), used only
   for step 2. `npm whoami` must answer the account that owns the scope.
2. npm CLI `>= 11.5.1` and Node `>= 22.14` for OIDC (the workflow pins both).

## 1. Claim the names (one initial publish)

npm can only configure a trusted publisher for a package that **already exists**, so a brand-new name
needs one initial publish with a token:

```sh
pnpm install
pnpm build

for dir in packages/core packages/client packages/adonis packages/dashboard packages/integrations packages/react; do
  (cd "$dir" && npm publish --access public)
done
```

That publishes the placeholder `0.0.0` of each package. (`npm publish --dry-run` first, if you want to
see the tarball contents.)

## 2. Configure trusted publishing (per package)

npmjs.com → the package → **Settings → Trusted publishing → Add**:

| Field | Value |
| --- | --- |
| Provider | GitHub Actions |
| Organization or user | `DavideCarvalho` |
| Repository | `adonis-agora-crypto` |
| Workflow filename | `release.yml` |
| Environment name | *(empty)* |
| Allowed actions | **also allow `npm publish`** — configurations created after 2026-09-03 default to staged publishing only, and this workflow publishes directly |

Repeat for the six packages. A configuration **expires after 2 days** without a successful publish, so
do step 3 right away; if it expires, delete and recreate it.

## 3. Merge, and let CI release

Merging a PR that carries a changeset *is* the release: the workflow versions the packages
(`0.0.0` → `0.1.0`), publishes all six with provenance, pushes the `chore: version packages` commit and
the git tags. Watch the run; a failed publish leaves the version commit un-pushed.

## 4. After the first successful OIDC release

- Verify: `npm view @adonis-agora/crypto version` and the *Provenance* badge on npm.
- Lock it down: package **Settings → Publishing access → require 2FA and disallow tokens** (trusted
  publishers keep working; they use OIDC).
- Revoke the bootstrap token.

## Manual snapshot

`workflow_dispatch` on **Release** runs the same gates and publishes a throwaway `beta` snapshot
without versioning or tags.
