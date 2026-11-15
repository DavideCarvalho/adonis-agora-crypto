# @adonis-agora/crypto-integrations

The 0.x package that plugs `@adonis-agora/crypto` into the other Agora libs without touching them.
One subpath per seam; every helper takes `{ source, key? }`, where `source` is `{ client }` (remote)
or `{ service, partition }` (the server embedded in the app).

| Subpath | What it gives you | Default key |
| --- | --- | --- |
| `@adonis-agora/crypto-integrations/authkit` | KMS root for authkit-server (`crypto.kms`) + doctor check | `authkit-root` |
| `…/agent` | KMS root for agent's poppy connections + doctor check | `agent-poppy-root` |
| `…/config` | KMS root for the config control plane + doctor check | `config-root` |
| `…/durable` | `encryptedTransport` / `encryptedControlPlane` decorators | `durable-tasks` (you name it) |
| `…/flags` | envelope `fetch` for `transports.http` and the posthog/clickhouse sinks | `flags-events` |
| `…/http` | envelope `fetch` for any call (authkit token, config tenant, …) + middleware re-exports | you name it |

```ts
import { configKms, configKmsCheck } from '@adonis-agora/crypto-integrations/config'

export default defineConfig({
  crypto: { kms: configKms({ source: { client: crypto } }) },
})
```

Docs: <https://davidecarvalho.github.io/agora/docs/crypto/integrations>
