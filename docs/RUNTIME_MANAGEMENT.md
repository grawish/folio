# Recorded compilers and offline repair

Folio now keeps a verified local copy of each compiler used by a project. Updating the app does not silently move an existing project to a different compiler or resource bundle. This is implemented on the tested macOS Apple silicon development build; the broader release requirements remain in `RELEASE_GAP_AUDIT.md`.

## Everyday behavior

- A new project records the included compiler when the app starts. Saves, recovery, Save As, source ZIPs and saved source/PDF versions retain that choice.
- **Settings → About → Repair compiler** restores the recorded version from the matching installer files or a verified retained copy. It keeps the resume source and compiler choice intact.
- A damaged or missing compiler prevents builds. Editing and saving remain available. If that exact compiler is unavailable locally, the app explains that a matching Folio version is needed; it does not substitute the current version.
- First launch copies and checks the included runtime and runs a small offline TeX and bibliography build when Biber is included. Later launches reuse that copy. Repair stages another copy before switching to it.
- A preparation screen protects the workspace until recovery has loaded. Closing during preparation leaves the previous recovery file untouched. If startup fails, Retry is available and the starter draft is never written over saved recovery.
- General, privacy and AI connection settings remain separate. AI provider and model selection still happens only in Settings.

## Identity and persistence

`RuntimePin` records Tectonic version, resource bundle label, platform, optional Biber version and a SHA-256 identity over the canonical manifest inventory. Reusing a version label with different file hashes produces a different identity. Verification checks every locked file and refuses unexpected files, symlinks and invalid paths.

The project manifest includes `runtime` plus legacy `engine`/`bundle` labels derived from that same choice. A legacy labels-only project adopts the included complete identity only when the labels match; an incompatible recorded choice remains unavailable. Projects with no prior choice adopt the included version. Malformed compiler choices are rejected instead of discarded.

Build fingerprints include the compiler choice. A PDF from another compiler identity cannot be exported as the current build, even when source and project revision otherwise match. Source/PDF history retains each version's compiler choice. Older history without a recorded choice uses the current project's choice when restored; it cannot reconstruct information that was never saved.

## Repair transaction

Managed data lives under the application's `runtimes` directory, grouped by manifest identity. An atomic `active.json` pointer selects a generation in `copies`. Each ready generation contains a matching `ready.json` marker and its runtime directory.

1. Verify the included files against the requested identity.
2. Copy files into a new, separate generation with bounded copy concurrency.
3. Verify the complete copy and run an offline compiler self-test, including the bundled Biber helper.
4. Flush a ready marker, atomically replace the active pointer, and flush its parent directory.
5. Keep the previous generation and any generation leased by a running build. Remove other owned, unused generations.

A failed stage or self-test keeps the active pointer unchanged. A process exit after pointer publication leaves the tested replacement selected. Interrupted staging is never selected; a subsequent repair safely retries. Real process-kill tests cover staging, self-test completion and pointer publication. These are process-interruption checks, not a claim of power-loss durability on every filesystem.

Retained older versions can be repaired from another verified copy of the same identity after the installer changes. Compiler leases prevent cleanup from removing a copy still in use. Builds use separate temporary project snapshots and a cache namespace for that compiler identity; the OS sandbox cannot write into the selected compiler directory. Ordinary document builds retain the existing 30-second process limit. Preparation uses a separate, bounded 60-second limit for a tiny app-owned TeX/Biber fixture. That check runs before the ready marker is published, so first-execution helper preparation happens before the user starts a document build.

## Verification

- `tests/runtime-manager.test.ts` covers content identities, invalid paths/links, self-test failure, corruption, changed installers, old-version retention, leases, persistence and forced process interruption. The complete unit suite passed 94 tests in `test-results/runtime-unit-tests.log`.
- `tests/integration/runtime-manager.test.ts` uses the actual packaged engine, Unicode/spaced compiler paths, the complete imported font/package corpus, a project bibliography processed by Biber, deliberate resource corruption and offline repair. All 11 real compiler integration tests passed in `test-results/runtime-integration-tests.log`.
- The original embedded-bibliography compatibility fixture remains in `compiler.test.ts`. For the managed repair test, the same bibliography is supplied as a separate project file so the fixture does not continually rewrite it during TeX passes. The user-document timeout and package/font coverage were not relaxed.
- `scripts/test-runtime.mjs` checks first launch, native Save, damaged-copy rejection, repair in Settings, source/version/ZIP pin preservation, unavailable versions, minimum-window dark/light screens and restart. All data and deliberate corruption are confined to a synthetic test profile. Startup regression source evidence: `test-results/runtime-Vte74V/`; final packaged evidence: `test-results/runtime-wh4NuI/`. Both passed with zero renderer errors. Package hashes are recorded in the release README.
- The early-close regression first reproduced the previous recovery being overwritten by the starter template (`test-results/runtime-GqFsEf/`, `runtime-startup-reproduction.log`). It now checks byte-for-byte preservation when closing during preparation, ignored project menu actions before startup completes, explicit startup errors, Retry and closing after a load failure.
- The observed integration run took 44.6 seconds for first-time preparation and 47.8 seconds for repair plus rebuilding the full bibliography fixture. These are development-host observations, not reference-device performance acceptance. Steady-state simple resume builds and the existing template corpus remain separately exercised.

## First-run bibliography regression

Repeated fresh-profile desktop testing exposed a real first-build failure: the full embedded-bibliography fixture sometimes exceeded the 30-second document limit after copying a new Biber executable. The captured failure is in `test-results/packaged-rR7Ig3/failed-build.log`. A warmed rerun succeeded, so merely increasing the UI test wait would not have fixed it.

Preparation now exercises both TeX and Biber before making the managed runtime available. Three consecutive source desktop runs with fresh profiles passed the original embedded-bibliography fixture: `test-results/packaged-AMnLHD/`, `packaged-68ReVa/` and `packaged-HR7sSQ/`; logs are `runtime-prepared-cold-{1,2,3}.log`. The rebuilt app also passed the original fixture with a fresh profile in `test-results/packaged-tWecz7/` (`runtime-package-packaged-final.log`). These runs support the fix on this development host; they do not replace clean-machine or reference-device release acceptance. Native test harnesses wait separately for initial preparation and for the normal document build, preserving their existing document-rendering deadlines.

## Still required by the original plan

An explicit included-compiler migration with a backup and visible before/after PDFs is now implemented; see `COMPILER_MIGRATION.md`. A signed pack catalog, offline pack import and resumable online repair; signing-aware manifests; bounded retention across all historical identities; clean-machine, power-loss and reference-device performance acceptance remain open. The current local repair does not implement these requirements or fetch packages during compilation.

Pins currently identify one OS/CPU build. Opening a project on a different platform preserves that pin and refuses compilation rather than guessing an equivalent compiler. Existing project files remain editable. Other operating systems and CPU targets are outside the user’s current Apple silicon Mac scope.
