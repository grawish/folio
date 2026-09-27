# Compiler storage review and admission

The development source adds **Settings → Storage**. It leaves AI provider configuration in Settings and does not change the chat-first workspace.

## Scope and preservation

`RuntimeManager.storage` serializes inspection with preparation, repair, resource-pack installation and lease changes. It reports logical file bytes under the owned `runtimes` root, including self-test data. Individual rows represent exact compiler identities or interrupted removals. The app bundle, ordinary build caches, saved resumes, history, retained pack archives and recovery journals are outside this total.

A removable installed identity must contain recognized copy folders, matching manifests and ready markers. Unknown or unfinished installation contents are preserved. The included identity, current recovered project pin (including a matching legacy labels-only choice), and every leased identity are protected. The renderer flushes its current project to recovery before requesting a removal. Main reads that recovery pin itself and blocks project-changing operations during the review. It also refuses removal during an AI request or current preview build.

Folio cannot enumerate all closed projects or disconnected drives. Removal is explicit and can make another saved project’s compiler unavailable. The confirmation gives version, bundle, full identity, size and restoration guidance; Cancel is the default. No source, project manifest or recorded compiler choice is rewritten.

## Removal and interruption

The native handler locates the entry in a fresh main-process inventory. After confirmation, the manager rechecks protection and a snapshot token derived from every reviewed path and its device/inode, mode, link count, size and timestamps. Changes require a new review. The renderer never supplies an arbitrary disk path.

A confirmed identity is renamed to an app-owned `removing-<identity>-<UUID>` folder, then the parent directory is flushed. Files are unlinked individually after identity/stat checks and directories are removed only when empty. There is no recursive sweep of newly added files. A failure or process kill leaves a visible unfinished-removal row; a fresh explicit review can finish it even if some manifests were already removed. Shutdown waits for a running removal, and native close cannot dismiss its pending confirmation.

Inspection uses bounded directory iteration, at most 200,000 entries and 32 levels. Links, hard-linked regular files and special files are rejected. This protects normal corruption/interruption scenarios; pathname checks do not claim race-proof deletion against a hostile local process with the same account. Real power-loss and supported-filesystem acceptance remain separate.

## Installation admission

Before copying files or changing an active pointer, staging totals the actual source/override lengths. It requires:

- Existing logical compiler-root bytes + proposed copy + 256 MiB allowance ≤ 16 GiB.
- Free bytes on the compiler-root volume ≥ proposed copy + 256 MiB allowance + 1 GiB.

Free bytes use `statfs.bavail × bsize` with integer arithmetic. The allowance covers metadata and the small offline check conservatively; it is not a measured maximum, physical APFS usage, reserved disk space or a hard OS quota. The original active compiler remains selected on admission failure. Other processes can consume space afterward; ordinary write/verification failures still leave the old selection intact.

No old compiler identity is evicted automatically. Per-identity retention still keeps the active copy, previous copy and leased copies. Unrecognized or interrupted installation files remain protected and can need troubleshooting; this page is not a general filesystem cleaner. Whole-profile retention and full-disk/device acceptance remain required by the release plan.

## Evidence and reproduction

- `node --import tsx --test tests/runtime-manager.test.ts` covers exact totals, protection, real leases, preserved source/pins, stale reviews, links/unknown files, interrupted removal, real SIGKILL recovery and simulated free-space/sparse logical-budget failures.
- `npm run test:runtime` exercises the source-built Mac Settings workflow with a real included compiler and an inert old identity, then continues repair, export, restart and unavailable-version checks.
- `npm run test:integration` checks actual compiler/resource-pack behavior.
- The hosted candidate workflow retains storage screenshots and the runtime result from the exact packaged app.

See [the user walkthrough](tutorials/settings-and-compiler.md#make-room-for-compiler-files). Local source evidence does not qualify a later binary or establish signed installation acceptance.

[Exact local verification and input hashes](releases/compiler-storage-verification.json) record the completed 333 source tests, 16 compiler integrations, native workflow and website checks. The storage rows appeared after 1.300 seconds in this single workflow observation; concurrent local checks and shared caches prevent treating it as a benchmark.
