# Temporary build recovery

When Folio builds a PDF, it works on a temporary copy of your source and images. After a normal build it removes that copy. In the development source, reopening Folio also cleans up recognized temporary copies left by a crashed app. Your project files, saved PDFs, conversation and History stay separate.

This behavior applies to the current development source. The published preview 4 uses the older temporary-folder layout.

## What Folio keeps

Folio keeps a temporary job while its owning process is still present. It also keeps it when the operating system cannot confirm whether the owner has exited. Reusing an old process number can therefore postpone cleanup, which protects active work.

Unknown or damaged ownership records, unexpected files, and folders from the older unmarked layout are preserved. Compiler caches are preserved too. Do not delete an unfamiliar folder to try to speed up a build. These protections mean this feature does not impose a total disk-space limit or remove every historical temporary file.

The cleanup starts with the compiler service. Chat drafts, editing and saving do not wait for it. A new PDF build waits until that scan settles. If cleanup cannot remove a recognized folder, it remains available for a later scan; a cleanup problem by itself does not discard your project or change its selected compiler.

## How ownership is checked

`electron/core/build-workspaces.ts` manages a private `.folio-build-jobs-v1` folder inside each compiler work root. Each `job-<UUID>` contains an `owner.json` record and a `files` directory. The existing macOS sandbox may write inside `files` and the engine cache; it cannot overwrite the ownership record above `files`. Ownership is recorded before any source or asset is staged.

A record identifies its format, job ID, owner process and exact directory identities. Cleanup checks the record's bounded size, regular-file identity, ownership, link count, allowed fields and matching directories. A live owner or uncertain process check retains the job. Directory links and changed or unrecognized entries are not followed into deletion. Links nested inside a recognized snapshot are removed as links; their targets survive.

Before removing a dead owner's snapshot, Folio renames the containing job to `removing-<UUID>` and checks its identity again. If the app stops during deletion, a later scan can resume that state. It removes the snapshot, then the ownership record, then the empty enclosing folder. The final folder removal refuses unexpected contents. An empty interrupted-removal folder can be removed without a remaining record because the filesystem operation refuses nonempty directories.

The scan reads directory entries incrementally. It does not load all job records or source files into memory. A single record read is capped at 2,049 bytes, including a byte used to reject an oversized record. Failed allocation after a valid record is written clears the recognized empty job. A torn or missing record is preserved; no source is staged before the record write completes.

The [compiler process watcher](COMPILER_RESOURCE_LIMITS.md#if-the-app-crashes) separately stops orphaned native work after parent death. Cleanup does not guess which unrelated processes it might be safe to kill.

## Verification and remaining work

`tests/build-workspaces.test.ts` covers normal release, active owners, uncertain process checks, repeated killed snapshots, three real cleanup interruption points, malformed and oversized records, directory identity mismatch, links, unknown files and destinations, and allocation failure. The native sandbox check first proves that writing inside the snapshot works, then proves that overwriting its ownership record is denied. The original Compiler fails the startup-recovery control.

`tests/integration/build-recovery.test.ts` uses the production Compiler to stage two real source snapshots, kills their owning processes before native execution, then checks startup cleanup and a new offline PDF build. The original project source, unmarked data and an engine-cache guard must survive, and the successful new job must also be removed.

These are process-interruption controls. They do not prove physical power-loss durability, acceptance on every supported Mac, large-backlog responsiveness, whole-profile storage quotas, or automatic removal of older unmarked folders. Those remain in [the release audit](RELEASE_GAP_AUDIT.md) and [performance plan](PERFORMANCE_IMPROVEMENT_PLAN.md#compiler-work-after-an-application-crash).
