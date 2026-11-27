---
"@adonis-agora/crypto": patch
---

Fix `import '@adonis-agora/crypto'` failing in 1.1.1 with `Cannot find module …/dist/stubs/main.js` under plain Node (a compiled app; apps running through a TypeScript loader resolved it to the `.ts` source and did not notice). The build now compiles `stubs/main.ts` and no longer deletes it when copying the stubs, and `check:package` imports the built main entry with plain Node.
