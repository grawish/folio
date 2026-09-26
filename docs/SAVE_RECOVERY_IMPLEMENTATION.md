# Guided save recovery: implementation progress

The recovery engine is implemented and tested. **The desktop review screen and its IPC/store integration are not connected yet.** Users still see the existing recovery error when outside edits prevent automatic rollback. This document records the engine contract and remaining integration work; it is not a user tutorial or a completed-feature claim.

## What the engine can do

`SaveTransactions.review()` reads the original journal and compares three versions for every affected file: before the save, the attempted save, and the current disk copy. The review identifies outside edits and distinguishes an absent file from a missing or damaged backup. It includes size and hash information; text is fetched separately with a 64,000-character output limit. Invalid UTF-8 and binary assets remain byte-preserving choices without a text preview.

A review token covers the journal, any earlier recovery decision, every version's availability/hash/size, and current file permissions. Applying a stale review fails. Callers must choose exactly one available version for every file; choices can include keeping a deletion or restoring a file that had been removed.

Before changing project files, the engine durably retains **every available version**, including outside edits, under content-addressed `kept-<sha256>` filenames. It records the reviewed file mapping and choices in `decision-<id>.json`, then publishes `resolution.json`. Interrupted copy writes cannot publish a partial retained copy. All project destinations and selected copies are checked before the first replacement, and each destination is checked again before its replacement.

Recovery choices have their own durable completion marker. A stopped process resumes those choices instead of falling back to the earlier automatic rollback. A newer outside edit during partial recovery stops further writes; a fresh review can preserve that newer edit and choose again. Earlier decisions and retained bytes remain available.

After completion, the entire original journal, original old/new files, retained versions and decision records move to `save-recovery-copies/<journal nonce>` inside the app data directory. These private local copies are not encrypted or uploaded. No automatic archive deletion is implemented. Files added or removed by the interrupted save, binary history, and file permissions use the same recovery path.

## Current verification

The current suite passes **150 unit/protocol tests** (`test-results/save-recovery-all-unit.log`). Fifteen new tests in `tests/save-recovery.test.ts` cover:

- review without writes, outside edits, additions, deletions and binary files;
- mixed, all-before and all-attempted selections with byte-for-byte retained copies;
- stale source, backup and permission checks; invalid, duplicate and missing choices;
- explicit selection around a damaged original backup while retaining its damaged bytes;
- actual child-process kills after decision publication, during application, after the completion marker, and after archive movement;
- newer outside edits during partial recovery, followed by a fresh decision retaining both outside versions;
- outside edits after completion, malformed decision records, missing retained copies (including unselected outside edits), archive destination failures and retries;
- malformed journals, unsafe parent/leaf symlinks, bounded text output and invalid UTF-8 byte preservation.

The fifteen existing save-transaction tests pass as well, covering automatic rollback, committed saves, deletion, Save As, metadata/history conflicts and history integrity. TypeScript and production build pass. The source-native chat/save regression suite passed with no renderer errors (`test-results/chat-74dHLx/`, log `test-results/save-recovery-chat.log`); it exercises the existing desktop save, Save As, history and recovery flows, not the unconnected guided review UI. The crash fixture is `tests/fixtures/save-recovery-crash.ts`; it waits at a precise boundary until its parent sends SIGKILL.

## Remaining integration and acceptance

1. Add a serialized store service that discovers only app-owned save journals and accepts opaque record IDs. Renderer input must not grant arbitrary filesystem paths or bypass the existing project save queue.
2. Preserve the unsaved workspace before a guided resolution. Make startup and normal project opening load the selected disk result after resolution, including a kill between completion and reopening. An older autosaved draft must not immediately overwrite the selected result; retain it as a separately recoverable copy.
3. Provide review access from a failed startup and from the project menu. Show current/before/attempted bytes, missing/damaged choices, deletions, and a clear confirmation of the selected result. Keep current outside edits as the initial suggestion. Allow refreshing a stale review and opening the retained-copy folder.
4. Coordinate Apply with builds, agents, autosave, native close and renderer reload. Wait for in-progress resolution on close; do not allow a competing save to erase its record.
5. Exercise actual native UI flows in both themes at 1040 × 680 and a larger window, including damaged backups, stale reviews, close/reload during Apply, startup recovery, existing draft preservation, source/asset/history round trips and render errors. Qualify the exact packaged app with this suite.
6. Capture synthetic screenshots and add the feature tutorial, gallery entry and skill guidance once the UI is implemented and verified. Until then, keep the release audit open.

## Limits

The engine rejects more than 500 MiB of combined available review versions; the existing per-file 100 MiB and 404-entry journal bounds remain. Retained archives can accumulate and require a future storage/retention policy. A damaged retained content-addressed copy or malformed journal/decision may require manual repair; neither is silently replaced or discarded. A mixed choice can produce an invalid project manifest or inconsistent history, so opening the selected result must report validation errors truthfully without deleting its backups.

Process-kill checks do not establish power-loss durability, network-filesystem guarantees, a lock against hostile concurrent filesystem mutations, or supported-macOS acceptance. Project replacements remain individually atomic; another program may observe intermediate files.
