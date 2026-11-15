---
'@adonis-agora/crypto-react': minor
---

The browser/React SDK for the asymmetric half of a share.

`createBrowserIdentity()` gives each person an X25519 key pair; `sealBrowserIdentity(identity,
passphrase)` keeps the private half sealed (PBKDF2-SHA256 + AES-256-GCM), and only the public JWK is
stored or registered. `sealTo(recipientPublicKey, payload, { aad })` and `openWith(privateKey,
sealed, { aad })` are byte-compatible with the Agora crypto kit — a browser-sealed share opens with
the kit and vice versa (tests cover both directions).

`<CryptoProvider>` + `useCrypto()`/`useSealTo()`/`useOpenWith()`/`usePublicKey()` expose the unlocked
identity to a React tree, with `unlock`, `create` and `lock`; the app decides when to ask for the
passphrase and where the sealed document lives (`localStorageIdentityStorage()` included).

Runs on `@noble/curves`, `@noble/hashes` and `@noble/ciphers` (no Node built-ins): a React app, a
worker or a test.
