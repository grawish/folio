# Project save reliability

The save path now treats source writes/removals, copied assets, `resume.project.json`, `resume.folio`, and `resume.trash` as one recoverable operation.

## Behavior

1. Prepare and validate the whole history archive before modifying the project folder. Invalid/damaged snapshots and size limits fail while previous project files remain unchanged.
2. Read all destination files and detect changed/deleted source, changed metadata/history, asset collisions, and unsafe parents before replacing anything.
3. Write private staged files, original-byte backups, hashes, permissions and a journal under Folio's application data directory. Files are flushed; directory entries are flushed on the tested macOS path.
4. Replace each destination atomically, then remove retired source paths after their recoverable copies are written. Publish a durable commit marker only after every write and removal succeeds.
5. On a write failure, restore every previous file and remove newly created files. If a process is killed, inspect the journal before the next project open, asset read, save or recovery load and complete that rollback.
6. A committed operation remains committed after a crash during cleanup. A finished rollback also has a durable marker so cleanup can resume without requiring deleted backups.

Folio serializes project saves. A second app process using the same profile exits instead of competing over recovery records. Save As briefly makes the workspace inactive while the copy is prepared, preventing edits or new requests from being attached to the wrong project. Close waits for an in-progress save and records the resulting project identity.

## Conflict handling

Recovery compares current bytes with both the old and prepared hashes. If a file changed after the interrupted save, Folio keeps that edit and all backups and reports the affected file and backup location. It does not silently choose a version. A damaged/missing backup likewise stops recovery before changing project files.

The source/manifest/history transaction determines save success. Failure to update the recent-project list or local recovery after the project is committed produces a **saved with warning** result. It no longer reports a complete save failure after changing the user's files.

Save As writes a new identity into both the manifest and history archive. Source ZIP exports use the same identity in those two files. History export and import share the limits of 1,000 versions, 200 MB expanded, 100 MB compressed, and 25 MB per entry. Export verifies snapshot hashes before writing an archive. Import rejects duplicate or excessive version records before creating files.

## Pending workspace writes

Development builds admit at most four pending workspace writes for one project and eight across the workspace store, counting active operations. These writes save conversation state or create source/PDF history versions. Accepted operations run in order within each project; an excess request receives “Folio is finishing other workspace saves. Try again in a moment.” before its storage operation starts. Requests are not silently discarded or substituted for one another.

Finishing or failing an operation releases its admission slot. The queue removes its last settled promise and count when that project has no pending work, so opening many projects does not retain a promise for every past project. A failed write still rejects its caller; subsequent writes can recover. `flush()` waits for the operations pending when it is called, and reports any failure among those operations. Existing project Save and close paths still flush the current workspace.

Three real-file controls check mixed draft/version ordering, rejection before new version files are created, eight-project saturation, slot reuse over 32 different projects, and recovery after invalid saved state. The two capacity controls reject the former unbounded implementation. These are operation-count limits, not a whole-app memory quota or a historical-storage retention policy. Archive compression has its separate bounded queue below. See [verification](releases/workspace-queue-verification.json).

## Background history compression

Development builds prepare history ZIPs in one reusable Node worker. `WorkspaceStore.archive()` queues a small loading callback before reading the history, so several requests cannot each load a full history at the same time. It admits one active request and at most three waiting requests. A full queue reports a retryable save error. Source and PDF fingerprints are still checked before compression; the project transaction still waits for a complete archive before replacing any file.

The worker stores each PDF verbatim and compresses the source/conversation JSON. All decoded bytes, version records and archive limits remain unchanged: 1,000 versions, 2,001 entries, 25 MiB per entry, 200 MiB input and 100 MiB output. This ZIP layout is readable by the existing importer. It increases the measured 100-version archive size by about 3.1% while avoiding repeated compression of PDF data. If that layout exceeds 100 MiB, the same worker retries the original fully compressed representation before rejecting it. Previously savable near-limit histories therefore retain that path. The same deadline covers both attempts. It does not remove older history or change retention policy.

The controller copies Node buffers into dedicated transferable arrays, yielding between batches, then transfers ownership to the worker. Compression has a 30-second deadline. Errors, wrong responses, early exits and timeouts retire the worker before a subsequent request creates another. An idle worker exits after five seconds; queue bookkeeping retains no completed ZIP result. `WorkspaceStore.flush()` also waits for outstanding archives, so the app’s existing close/recovery paths continue to wait for them.

The worker has 64 MiB old-generation and 16 MiB young-generation JavaScript heap limits, plus a 4 MiB stack. These are **not total process-memory limits**: Node documents that external `ArrayBuffer` data is outside these heap limits. Input/output/count bounds limit the admitted data, but copying, validation, filesystem reads and other app work still need broader memory and upper-bound acceptance. See [Node worker limits and buffer transfer](https://nodejs.org/download/release/latest-v22.x/docs/api/worker_threads.html).

`history-zip-worker.cjs` is bundled as a sibling of `main.cjs` inside the app archive. The main build supplies a CommonJS module URL so the same worker path works in source execution and the packaged app, without enabling Node in the renderer or changing the preload boundary. The worker receives bytes, not filesystem paths or executable instructions. It is an app-owned computation thread, not a sandbox for untrusted code.

See [matched before/after measurements](PERFORMANCE_IMPROVEMENT_PLAN.md#background-history-compression) and [qualification evidence](releases/history-worker-verification.json). The unit controls cover exact bytes, queue limits, worker crash/exit/hang, incorrect replies, near-limit compression fallback, oversized input/output, idle cleanup and a real worker failure before a project save. Older published preview installers do not include this change.

## Project format upgrades

Folder and ZIP opening share a strict manifest reader: a present `resume.project.json` must be a UTF-8 JSON object, at most 64 KiB, with numeric `schemaVersion` 1 or 2. Unknown versions are rejected before the project is registered for editing. A folder without a manifest is still a normal supported TeX project. A malformed manifest is not treated as a missing one.

Opening a version-1 project leaves its folder unchanged. Matching old compiler labels may resolve to the included exact compiler identity in memory; differing labels stay pinned to their original selection. The next Save writes version 2, source and history through the existing durable journal, retaining the project identity and template origin. No separate in-place migration runs during open.

`tests/project-schema.test.ts` checks rejected newer/malformed manifests, folder/ZIP agreement, read-only opening, compiler-pin preservation, and a successful upgrade with history. Its child-process fixture invokes the real `ProjectStore.save()` and is killed after a source replacement, manifest replacement, history replacement, durable commit, and during rollback cleanup. Reopening restores the complete old project before commit, or retains the complete new project afterward. It verifies exact file bytes, matching history/source, stable identity and a second idempotent reopen. PDFs in these storage tests are synthetic header fixtures; compiler and viewer qualification remain separate.

The new nine-case suite and the full 207-test unit/protocol suite pass on the development Mac. Before the fix, the tests reproduced a newer version being accepted and malformed `null` metadata causing an unhelpful exception. Broader filesystem, power-loss and signed-app upgrade acceptance remain required.

The source-native import suite passes with no renderer errors in `test-results/import-u2e6E0/`. It opens a synthetic newer-format folder through the actual app, verifies the visible error and retained current PDF, and compares both folders' bytes before continuing the existing ZIP import/export, folder-open and close-during-import workflows. The [plain-language guide](tutorials/files-and-import.md) includes the reviewed native screenshot; its hash is recorded in `images/qualified-captures.json`.

## Evidence

`tests/save-transactions.test.ts` and `tests/fixtures/save-crash.ts` exercise actual files and a child process killed at specific journal boundaries:

- history preparation failure and unchanged destination/identity;
- write failure after multiple source replacements and full rollback;
- forced process kill midway through a save, followed by rollback before reopen;
- forced kill after commit, preserving all new files;
- forced kill after rollback but before cleanup, including a subsequently deleted backup;
- a leftover temporary replacement from an interrupted rollback;
- newer external edits and damaged backups preserved rather than overwritten;
- external deletion and changed manifest/history conflict detection;
- Save As asset collisions, dangling parent symlinks and canonical directory aliases;
- a recent-list failure reported truthfully after successful save;
- matching Save As identities and conversation archive round-trip;
- damaged snapshots and excessive/duplicate version records rejected.

The save milestone passed **49 unit/protocol tests**, production build, TypeScript and formatting checks. The original native desktop suite passed after the new save path. The final packaged chat suite passed with damaged-history save rejection, a second process exiting, and closing during Save As (`test-results/chat-vEiVJh/`). Artifact hashes and scope are recorded in `release/reliable-save/README.md`.

The later file-management work extends the same journal to deletion entries. Tests cover rollback after a deletion and a real process kill after a source file is removed, plus preservation of both unsaved buffers and newer disk bytes. See [file management](FILE_MANAGEMENT.md). That file-management milestone had 80 passing unit/protocol tests.

[External-file watching](EXTERNAL_CHANGES.md) compares both source and assets against the accepted disk baseline. Scans wait for complete saves. Reload writes preserved editor buffers and the new accepted source/asset baseline to recovery before publishing the result. Source replacement after an explicit save-conflict choice retains differing outside UTF-8 text in `resume.trash`; storage limits and invalid text fail before writing any file. Metadata/history conflicts remain pending after a source reload.

## Limits

This provides crash-recoverable application consistency, not a filesystem primitive that atomically exposes many ordinary files to every external process. An outside editor can observe individual replacement steps. External changes are detected before replacements and recovery, but hostile concurrent filesystem mutation is not a portable lock guarantee.

Process-kill recovery is tested on the development Mac. Power-loss behavior, network filesystems and native Mac installer upgrades still need target-platform validation. The app does not promise survival of damaged storage or unavailable backups. Empty directories created before a failed save may remain; original file bytes and user edits are protected.

Journals and backups live in application data and follow its local permissions; they are not encrypted. A conflicting external edit can be resolved through the guided recovery review. It keeps available file versions, editor drafts and conversation copies before applying the chosen files, and preserves the decision through reload/close or a stopped write. Unreadable records and damaged retained storage can still require manual repair. See [guided recovery and remaining acceptance](SAVE_RECOVERY_IMPLEMENTATION.md).
