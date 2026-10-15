# Managing saved PDF history

Builds from preview 5 onward show saved-history usage in **History** and let the user remove a selected older version after confirmation. The current PDF and newest saved version are protected. Nothing is removed automatically. The older preview-4 installer predates this feature.

## Storage policy

New checkpoints admit at most 1,000 versions and 64 MiB of combined saved source/PDF bytes per project. Each source or PDF entry is also limited to 25 MiB. The smaller history budget leaves room for the separately bounded conversation, version metadata and ZIP overhead under the existing 100 MiB portable-archive ceiling, even when the snapshot data does not compress. Usage comes from actual file sizes, not renderer estimates or cached counters.

A checkpoint that would cross a limit fails before creating any new version files. The user keeps the editor source and earlier PDF, receives an explanation, and can remove older history before building again. Rebuilding the unchanged latest version does not need another slot. This is a limit on active indexed snapshots, not a total application-data, filesystem, memory or CPU quota.

Existing local history above the new budget is preserved. The existing importer still accepts valid portable histories within its original 1,000-version, 200 MiB expanded and 100 MiB compressed limits. No migration silently trims them. Further checkpoints wait until the user makes enough room. Older archives or backups elsewhere are not changed by local history removal.

## What removal changes

Removal commits the selected source/PDF deletion and conversation-index change together. It removes that version's active visual notes and draft attachment references. Sent note text remains in chat; a note whose PDF was removed no longer offers a thumbnail/navigation action, and Retry does not reattach that unavailable PDF. Other versions, the current editor source, current PDF and chat draft remain intact.

The project folder's `resume.folio` changes on the next normal Save, through the existing project transaction. The confirmation explains this. Local removal is not undoable through History; a separately retained project copy may still contain the old version. The ordinary Save conflict checks still apply to an externally changed portable archive.

The optional `historyRevision` field increments on removal. A stale renderer conversation save must present the same revision as the stored state or fail without changing it. This stops an older pending save from restoring removed references. Version appends still merge with the authoritative version list. The revision is preserved in portable archives and across restart; older archives without the field start at zero.

## Ordering and interruption

Checkpoint creation and selected removal use the existing durable save journal under `workspace-maintenance/`. Source/PDF files and their index become one recoverable operation. Before another workspace read/write, an unfinished journal restores the earlier state unless the durable commit marker exists. After commit, cleanup can resume without restoring the removed version. Conflicting outside edits or damaged backups stop recovery rather than overwrite them.

Version reads, storage measurements, archive snapshot loading, conversation saves, checkpoints and removals share ordering within each project. This prevents removal from tearing a PDF read or portable export. Read admission is separate from write admission: up to eight pending reads per project/sixteen across the store, alongside the existing four writes per project/eight total. Excess operations report a retryable error; settled operations release their capacity. Archive compression retains its separate worker queue and deadline.

The UI disables removal during a build, AI request or save. The native boundary also rejects active compiler/agent and incompatible maintenance operations. Once removal starts, Escape and dialog close wait; native window close waits for the resulting conversation revision before saving recovery. Unsaved editor recovery is written before removal starts.

The compiler releases its settled running-promise reference, so the activity check becomes idle after completion, failure or cancellation while retaining the normal current-PDF cache. Replaced builds cannot clear a newer build's activity state.

## Verification and scope

Run the store controls and the real desktop workflow with:

```sh
node --import tsx --test tests/history-storage.test.ts tests/workspace-queue.test.ts
npm run test:history-storage
```

The controls use real temporary files. They check byte/count admission, retry after removal, preserved notes/drafts/current bytes, stale-save rejection, portable round-trip, write-failure rollback, linked-folder rejection, read/write capacity, concurrent export, and compiler activity. Four child-process kills exercise removal after each file/index application and after commit, followed by exact recovery and a second reopen. PDFs in these storage controls are synthetic byte fixtures; the desktop workflow builds and renders real PDFs.

The desktop script uses isolated synthetic profiles, ordinary History controls and real PDF annotations. It covers cancel/confirm, compact dark/light layouts, current-version protection, saved-folder isolation, unsaved-source/draft preservation, portable Save, a held journal write, native close and restart. No AI account is used. See the [plain-language walkthrough](tutorials/chat-and-feedback.md#make-room-in-history).

The [verification record](releases/history-storage-verification.json) identifies the exact changed sources, test scripts, local app/disk image and screenshot hashes. All 274 source tests and 15 compiler integrations pass, followed by source and packaged history/chat workflows. All 39 packaged outputs and the runtime manifest match the current build. These targeted checks do not replace the complete fifteen-suite hosted qualification. [Checkpoint measurements](PERFORMANCE_IMPROVEMENT_PLAN.md#cost-of-recoverable-history-checkpoints) attribute the measured roughly 0.10-second cost mainly to the journal.

Power-loss behavior, hostile simultaneous filesystem mutation, broader macOS acceptance, whole-profile quotas, old unindexed files and recovery-backup retention remain separate work. Interrupted operations can leave empty directories or cleanup backups; they are not counted as active saved snapshots. This feature does not delete older project copies or promise to free every byte reported by Finder.
