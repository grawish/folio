# Contributing to Folio

Contributions are welcome under the project's PolyForm Noncommercial terms. Use synthetic resumes and accounts in tests and examples. Do not commit API keys, account sessions, real resumes, build output, or test profiles.

## Development

Use an Apple silicon Mac and Node.js 24. Run `npm ci`, `npm run setup`, then `npm run dev`. Setup needs the network; normal document compilation uses the verified local resource bundle. Use `FOLIO_USER_DATA=/absolute/path/to/a/separate/directory npm run dev` when testing recovery without touching your usual app data.

The renderer is in `src/`, the native bridge in `electron/preload.ts`, and privileged operations in `electron/main.ts` and `electron/core/`. Read [architecture](docs/ARCHITECTURE.md) before changing these boundaries.

Before a pull request, run `npm run typecheck`, `npm test`, `npm run format:check`, and the native suite that exercises the changed behavior. Native tests open real windows: run them sequentially. Compiler integration tests require macOS Seatbelt support and must run outside an enclosing sandbox that prevents `sandbox-exec`.

```sh
npm run test:integration
npm run test:chat
npm run test:import-recovery
```

Tests write synthetic profiles and evidence under ignored `test-results/`. They do not require a paid AI account; provider fixtures must stay visibly identified as simulations.

## Packaging

```sh
CSC_IDENTITY_AUTO_DISCOVERY=false npm run dist
node scripts/test-mac-release.mjs release
node scripts/verify-mac-package.mjs release
```

These commands produce and test an unsigned Apple silicon development build. Do not describe it as notarized or a stable release. Signing changes runtime bytes and needs signing-aware integrity manifests before it can be enabled. Read [the release audit](docs/RELEASE_GAP_AUDIT.md).

Keep `package-lock.json` committed. Runtime archives and generated dependencies are downloaded during setup and stay ignored. Changes to `resources/bundle.lock.json` require deliberate corpus review and offline verification; do not update it simply to suppress a checksum failure.

## Pull requests

Describe the user-visible problem, the resulting behavior, and checks actually run. Include a synthetic screenshot for meaningful interface changes. Link any remaining limitation. Preserve Settings-only AI connection selection, the chat-first workspace, last-good PDF behavior, and protection for unsaved or externally changed source.
