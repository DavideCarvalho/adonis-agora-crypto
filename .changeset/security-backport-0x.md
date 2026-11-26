---
"@adonis-agora/crypto": minor
---

Security fixes backported to the 0.x line.

**Breaking:** federated console commands are now authenticated with a shared secret.

- The owning app must set `consoleCommands.secret` (at least 16 characters), and the console must set the same value as `federatedApps.<app>.controlPlane.secret` on every entry that may act (`actions` not `false`). Without it the web process refuses to boot and the error names the option to add. Both sides must be upgraded together.
- Every command and every answer is signed (HMAC-SHA256); an answer that does not verify is ignored. Commands older than one minute are refused and each command runs at most once. Malformed messages are dropped.
- The console always sends its viewer's capabilities, and the app refuses a command without them (`403`, code `capabilities-required`).
- The console's own partitions now honor the `capabilities` returned by `console.authorize`: create, rotate, policy and delete need `crypto:keys:manage`, testing a key needs its operations, and rewrap needs `crypto:rewrap:<key>`. An `authorize` that returns no `capabilities` keeps full rights. `/meta` returns the viewer's capabilities.
