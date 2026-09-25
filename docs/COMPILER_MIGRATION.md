# Changing a project's compiler

Scope: macOS on Apple silicon. This is an explicit project action in **Settings → About → Compare compilers**. It appears when the recorded compiler differs from the one included with Folio. Opening a project still keeps its recorded choice.

## User flow

1. Finish an AI request or save, and review outside-file changes.
2. Choose **Build comparison**. Folio captures the source and assets, builds with both compiler identities, and saves a complete local backup.
3. Inspect the two PDFs, using their page and zoom controls. **Keep recorded compiler** cancels the change. A completed backup remains available.
4. Choose **Use included compiler** to apply the new choice to the local draft and recovery. Ordinary Save or autosave updates the project folder afterward.
5. Find backups under **Settings → About → Compiler backups**. **Show backup** reveals the ZIP in Finder. Import it to restore the old source, assets, compiler choice and saved history as a separate project. Both comparison PDFs are stored beside it.

Chat stays the main screen. Code is secondary, and all AI connection/model controls remain in Settings.

## When the old compiler is unavailable

The comparison can use a previously saved PDF only if its recorded source fingerprint matches the current source, main file and old compiler identity. The UI explicitly labels this as **Before · saved PDF** and warns that it may use earlier assets. The new PDF uses the current captured assets. This is a visible comparison with a historical baseline, not a claim that every historical asset has been reconstructed.

If no matching PDF exists, Folio keeps the old choice and explains that the user must repair the old compiler or restore a saved version before comparing. Actual TeX errors with an available old compiler do not silently fall back to a historical PDF.

## Backup and transaction

Backups live under the app data directory's `compiler-backups/<project-id>/<comparison-id>/`:

- `source.zip`: current unsaved source, supported assets, removed-file copies, old runtime manifest fields and saved conversation/history, with an independent export identity.
- `before.pdf` and `after.pdf`: the actual compared PDF bytes.
- `record.json`: old/new identities, timestamp, baseline kind and SHA-256 digests of the three files.

The backup files are flushed before their record is published. Applying rechecks source/revision/name/metadata, outside-file state, asset hashes and backup integrity. Failed builds, cancellation, newer edits, changed assets, damaged backups or failed recovery writes leave the selected compiler unchanged.

Writing the new draft to recovery is the commit point. The UI waits for it before reporting success. A subsequent history-write failure reports that the compiler was changed and keeps the complete comparison backup; it does not falsely tell the renderer to continue with the old draft. Closing during Apply waits for the operation before flushing recovery. A renderer reload clears an abandoned comparison (or waits for Apply) before restoring the draft, so a lost UI token cannot block subsequent work.

Source ZIPs are limited to 100 MiB, each comparison PDF to 25 MiB, and the backup store to 1 GiB of regular-file content. The store also caps a project's backup folders at 100 and its overall entry traversal at 1,000. It refuses another comparison when full; it does not silently delete recovery copies. Older backups can be moved out of this app-owned folder using Finder. This is a checked storage budget, not an OS-enforced disk quota.

Comparison builds use the existing isolated compiler, immutable assets and ordinary 30-second document limits. A single comparison is active at a time. Manual/AI compilation and saves cannot race an active comparison through the IPC handlers. The viewer displays both real PDFs; no AI account is used for migration.

## Verification

`tests/compiler-migration.test.ts` covers independent backup restoration inputs, matching historical baselines, build failures, stale source/metadata/assets, outside changes, damaged/linked backups, full storage, cancellation, recovery failure and history failure after commit. Child processes are forcibly killed at completed backup publication and at the recovery commit; restarting preserves the correct old/new choice and the complete original backup. These are process-interruption tests, not power-loss acceptance.

The complete unit suite passed 104 tests in `test-results/migration-unit-tests.log`. Typecheck/build and formatting passed.

`scripts/test-migration.mjs` uses two real retained runtime identities. It creates the older fixture from the same engine/resources with a different manifest bundle label, so it tests identity changes and genuine builds without inventing an unverified older engine binary. It verifies both PDFs, source/asset/history backups, Cancel, the missing-runtime historical baseline, Apply, Save, exact exported bytes and restart. Native source evidence: `test-results/migration-JgMoln/`, with zero renderer errors. That iteration copied previously verified test runtimes into a fresh isolated profile; ordinary execution prepares both runtimes from scratch.

Final packaged migration evidence is `test-results/migration-izrL7z/`. It prepares both runtimes from scratch, verifies that reloading a prepared comparison releases the lost comparison token, and holds Apply while closing the native window to prove that the new recovered compiler choice survives. It also checks all comparison footer actions at the minimum 1040 × 680 size in dark and light appearances. No renderer errors were recorded. The exact packaged app hash is recorded by `release/compiler-migration/native-tests.json`. All five final native suites and disk-image verification passed; see [the release README](../release/compiler-migration/README.md) for hashes, evidence and the retained earlier startup-failure record.

Run `npm run test:migration`, or target a packaged app with `node --import tsx scripts/test-migration.mjs /absolute/path/Folio.app/Contents/MacOS/Folio`. All deliberate changes are confined to synthetic test profiles and projects.

## Remaining release work

Signed pack acquisition and retirement policy, signed/notarized app distribution, authenticated updates, Apple silicon macOS-version/clean-machine acceptance, power-loss validation and the other production gaps remain open. This flow currently compares with the included runtime; it is not a general catalog or downloader. Windows, Linux, Intel Mac and cross-platform runtime equivalence are outside the user’s updated goal.
