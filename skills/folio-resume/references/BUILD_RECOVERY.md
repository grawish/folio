<!-- Generated from docs/BUILD_RECOVERY.md; run npm run skill:build after editing the guide. -->

# Temporary build recovery

When Folio builds a PDF, it works on a temporary copy of your source and images. After a normal build it removes that copy. In the development source, reopening Folio also cleans up recognized temporary copies left by a crashed app. Your project files, saved PDFs, conversation and History stay separate.

This behavior applies to the current development source. The published preview 4 uses the older temporary-folder layout.

## What Folio keeps

Folio keeps a temporary job while its owning process is still present. It also keeps it when the operating system cannot confirm whether the owner has exited. Reusing an old process number can therefore postpone cleanup, which protects active work.

Unknown or damaged ownership records, unexpected files, and folders from the older unmarked layout are preserved. Compiler caches are preserved too. Do not delete an unfamiliar folder to try to speed up a build. These protections mean this feature does not impose a total disk-space limit or remove every historical temporary file.

The cleanup starts with the compiler service. Chat drafts, editing and saving do not wait for it. A new PDF build waits until that scan settles. If cleanup cannot remove a recognized folder, it remains available for a later scan; a cleanup problem by itself does not discard your project or change its selected compiler.

## Reopen and check your work

1. Open Folio again after an unexpected quit. The recovered source and unsent chat draft should return.
2. Open **Code** and review the text. Your last saved project files remain on disk separately from the recovered draft.
3. If a build restarts and stays busy, click **Stop**, then turn off **Auto-compile** while correcting the source. The current development source saves this setting in native storage. The earlier browser-storage implementation could reset a recently changed setting after an abrupt crash; see [preference recovery](https://github.com/grawish/folio/blob/main/docs/WORKSPACE_PREFERENCES.md#remember-settings-after-an-unexpected-quit).
4. Click **Compile** and inspect the new PDF. **History** keeps earlier successful versions for comparison.
5. Click **Save**, then **Export PDF** when the result is ready.

[Screenshot: Recovered chat draft beside a freshly compiled PDF](https://github.com/grawish/folio/blob/main/docs/images/build-crash-recovered.png)

This screenshot comes from the packaged-app crash check with synthetic source and an unsent chat draft. The check uses no AI connection.

## How ownership is checked

`electron/core/build-workspaces.ts` manages a private `.folio-build-jobs-v1` folder inside each compiler work root. Each `job-<UUID>` contains an `owner.json` record and a `files` directory. The existing macOS sandbox may write inside `files` and the engine cache; it cannot overwrite the ownership record above `files`. Ownership is recorded before any source or asset is staged.

A record identifies its format, job ID, owner process and exact directory identities. Cleanup checks the record's bounded size, regular-file identity, ownership, link count, allowed fields and matching directories. A live owner or uncertain process check retains the job. Directory links and changed or unrecognized entries are not followed into deletion. Links nested inside a recognized snapshot are removed as links; their targets survive.

Before removing a dead owner's snapshot, Folio renames the containing job to `removing-<UUID>` and checks its identity again. If the app stops during deletion, a later scan can resume that state. It removes the snapshot, then the ownership record, then the empty enclosing folder. The final folder removal refuses unexpected contents. An empty interrupted-removal folder can be removed without a remaining record because the filesystem operation refuses nonempty directories.

The scan reads directory entries incrementally. It does not load all job records or source files into memory. A single record read is capped at 2,049 bytes, including a byte used to reject an oversized record. Failed allocation after a valid record is written clears the recognized empty job. A torn or missing record is preserved; no source is staged before the record write completes.

The [compiler process watcher](https://github.com/grawish/folio/blob/main/docs/COMPILER_RESOURCE_LIMITS.md#if-the-app-crashes) separately stops orphaned native work after parent death. Cleanup does not guess which unrelated processes it might be safe to kill.

## Verification and remaining work

`tests/build-workspaces.test.ts` covers normal release, active owners, uncertain process checks, repeated killed snapshots, three real cleanup interruption points, malformed and oversized records, directory identity mismatch, links, unknown files and destinations, and allocation failure. The native sandbox check first proves that writing inside the snapshot works, then proves that overwriting its ownership record is denied. The original Compiler fails the startup-recovery control.

`tests/integration/build-recovery.test.ts` uses the production Compiler to stage two real source snapshots, kills their owning processes before native execution, then checks startup cleanup and a new offline PDF build. The original project source, unmarked data and an engine-cache guard must survive, and the successful new job must also be removed.

The [verification record](https://github.com/grawish/folio/blob/main/docs/releases/build-workspace-recovery-verification.json) retains the exact source and log hashes, 392 source tests, 21 focused controls, 16 existing compiler integrations, the new recovery integration, and the packaged runtime/chat results. Full [hosted qualification](https://github.com/grawish/folio/blob/main/docs/releases/mac-build-recovery-hosted.json) at `3a1ffef` passes 392 source tests, all 17 compiler integrations, twelve unchanged template images and all sixteen native suites. All 146 retained evidence files, test/build inputs, app inventory, JavaScript replay and original publisher materials were independently checked. This is unsigned source qualification; the public preview installer is unchanged.

`scripts/test-build-crash.mjs` additionally kills the actual packaged Electron main process during a real UI compile. It checks that the observed native group and app descendants exit, the abandoned snapshot remains before restart and disappears after restart, saved files stay byte-identical, and unsaved source, chat draft, compiler pin and PDF History survive. A new UI compile/save/export must produce the expected one-page PDF, verified with an independent PDF parser. The prior watchdog-only app fails specifically because its abandoned snapshot survives reopening. This is the seventeenth native qualification suite. Full [hosted qualification](https://github.com/grawish/folio/blob/main/docs/releases/mac-packaged-build-crash-hosted.json) at `9f642c3` passes all 17 native suites, 392 source tests, 17 compiler integrations and twelve unchanged template images. All 152 retained evidence files and exact source/package/original-material records were independently checked, including parsing the newly exported PDF. The hosted crash also records the Auto-compile reset; that issue remains separate from the source/chat/history recovery gate.

Run it on Apple silicon with `FOLIO_PYTHON` pointing to Python with the pinned PDF-test requirements installed:

```sh
node scripts/test-build-crash.mjs /path/to/Folio.app/Contents/MacOS/Folio
```

The [packaged crash verification](https://github.com/grawish/folio/blob/main/docs/releases/packaged-build-crash-verification.json) preserves the successful candidate, failing previous-app control and the initial preference-reset finding. That historical record does not claim Chromium preference durability. The newer [native preference change](https://github.com/grawish/folio/blob/main/docs/releases/workspace-preferences-verification.json) keeps all five workspace settings in a validated native file and strengthens the app-crash gate to require Auto-compile to remain disabled. Its local fresh-profile, old-profile migration and crash checks pass; full hosted qualification is tracked in that separate record.

These are process-interruption controls. They do not prove physical power-loss durability, acceptance on every supported Mac, large-backlog responsiveness, whole-profile storage quotas, or automatic removal of older unmarked folders. Those remain in [the release audit](RELEASE_GAP_AUDIT.md) and [performance plan](https://github.com/grawish/folio/blob/main/docs/PERFORMANCE_IMPROVEMENT_PLAN.md#compiler-work-after-an-application-crash).
