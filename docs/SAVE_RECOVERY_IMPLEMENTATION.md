# Guided save recovery

The desktop review is available from a failed startup or **More project actions → Interrupted saves…**. Users compare current, before-save and attempted-save copies, choose a version for each file, review the choices, and apply them while retaining backups. The [plain-language tutorial](tutorials/save-and-recover.md#recover-an-interrupted-save) includes real screenshots.

## What the engine can do

`SaveTransactions.review()` reads the original journal and compares three versions for every affected file: before the save, the attempted save, and the current disk copy. The review identifies outside edits and distinguishes an absent file from a missing or damaged backup. It includes size and hash information; text is fetched separately with a 64,000-character output limit. Invalid UTF-8 and binary assets remain byte-preserving choices without a text preview.

A review token covers the journal, any earlier recovery decision, every version's availability/hash/size, and current file permissions. Applying a stale review fails. Callers must choose exactly one available version for every file; choices can include keeping a deletion or restoring a file that had been removed.

Before changing project files, the engine durably retains **every available version**, including outside edits, under content-addressed `kept-<sha256>` filenames. It records the reviewed file mapping and choices in `decision-<id>.json`, then publishes `resolution.json`. Interrupted copy writes cannot publish a partial retained copy. All project destinations and selected copies are checked before the first replacement, and each destination is checked again before its replacement.

Recovery choices have their own durable completion marker. A stopped process resumes those choices instead of falling back to the earlier automatic rollback. A newer outside edit during partial recovery stops further writes; a fresh review can preserve that newer edit and choose again. Earlier decisions and retained bytes remain available.

After completion, the entire original journal, original old/new files, retained versions and decision records move to `save-recovery-copies/<journal nonce>` inside the app data directory. These private local copies are not encrypted or uploaded. No automatic archive deletion is implemented. Files added or removed by the interrupted save, binary history, and file permissions use the same recovery path.

## Current verification

The engine milestone passed **150 unit/protocol tests** (`test-results/save-recovery-all-unit.log`). Fifteen engine tests in `tests/save-recovery.test.ts` cover:

- review without writes, outside edits, additions, deletions and binary files;
- mixed, all-before and all-attempted selections with byte-for-byte retained copies;
- stale source, backup and permission checks; invalid, duplicate and missing choices;
- explicit selection around a damaged original backup while retaining its damaged bytes;
- actual child-process kills after decision publication, during application, after the completion marker, and after archive movement;
- newer outside edits during partial recovery, followed by a fresh decision retaining both outside versions;
- outside edits after completion, malformed decision records, missing retained copies (including unselected outside edits), archive destination failures and retries;
- malformed journals, unsafe parent/leaf symlinks, bounded text output and invalid UTF-8 byte preservation.

The fifteen existing save-transaction tests pass as well, covering automatic rollback, committed saves, deletion, Save As, metadata/history conflicts and history integrity. TypeScript and production build pass. The source-native chat/save regression suite passed with no renderer errors (`test-results/chat-74dHLx/`, log `test-results/save-recovery-chat.log`); it exercises the existing desktop save, Save As, history and recovery flows, not the unconnected guided review UI. The crash fixture is `tests/fixtures/save-recovery-crash.ts`; it waits at a precise boundary until its parent sends SIGKILL.

## Desktop, draft and history integration

The serialized project store discovers app-owned journal folders and accepts opaque record IDs. The renderer cannot supply arbitrary filesystem roots or replacement bytes. Native review sessions prevent competing source saves, agent work and compiler/font changes. Background source/chat recovery and autosave pause while the review is open. Closing or reloading waits for active Apply; an abandoned read-only review releases its session.

Before applying choices, the store preserves the profile recovery bytes, editor source and a validated local conversation/history archive. A durable `pendingSaveResolution` marker is written into profile recovery before the engine can modify project files. Startup uses this marker and the completed archive to reopen the selected disk files, including after a kill between archive movement and reopening. Ordinary save/recovery writes cannot erase a pending marker. Dismissing a failed partial Apply re-enters recovery.

The selected manifest can refer to a different cached conversation from the editor that opened the review. That cached conversation is separately archived before the selected `resume.folio` is imported. Only this explicit, backed-up path replaces newer local history with the chosen on-disk version; normal opens preserve the newer local cache. The marker is cleared after source and history have been reopened successfully. Failure to reopen is reported as **choices saved, workspace needs attention**, with retained-copy access. It is not reported as a rollback or a successful workspace load.

`tests/save-review-store.test.ts` adds eight store/history checks, including process kills at all four engine boundaries, profile/source/history preservation, stale or invalid records, explicit history replacement, and rejection of ordinary save/recovery/clear attempts while a decision is pending. The complete suite passes **158 tests** (`test-results/save-review-final-unit.log`).

The native suite `scripts/test-save-recovery.mjs` passes in `test-results/save-recovery-olVWdQ/` with no renderer errors. It covers failed startup; all three file versions; dark/light 1040 × 680 controls; read-only reload; stale review rejection/refresh; missing and damaged copies; binary assets, history and deletions; source/asset/conversation ZIP round trips; preservation of another project's editor draft; native close and renderer reload during a held Apply; and dismissal/retry after an injected partial write failure. The earlier native runs are retained as narrower checks. The latest captures use synthetic resumes and controlled interruptions, not real user files or an AI account.

The same workflow passed against the unsigned Apple silicon app in `release/save-recovery/mac-arm64/Folio.app` (`test-results/save-recovery-1mmuTT/`), including native IPC guards that reject competing save/open/import requests. Its app.asar SHA-256 is `dd9b1edd74789abe7b5f2da19fb6a1c8139f036304170f5685840ec01bb2ccf5`. All 37 packaged build outputs and the runtime manifest match. The local proof is `release/save-recovery/feature-verification.json`. This is targeted feature verification, not a disk-image or full thirteen-suite qualification. The broader packaged chat/save suite also passed (`test-results/chat-h4kir4/`), covering actual PDF review, history undo/restore, stale AI results, outside edits, damaged-history save rejection, Save As, autosave and close during Save As. The app archive remained unchanged. The qualification pipeline includes a thirteenth native suite for this feature. Earlier eleven-suite hosted results predate this code and remain evidence for their own recorded commit.

Broader macOS-version, physical accessibility, network-filesystem and power-loss acceptance remain in the release audit. No signed installer or complete production-release claim follows from these feature checks.

## Limits

The engine rejects more than 500 MiB of combined available review versions; the existing per-file 100 MiB and 404-entry journal bounds remain. Retained archives can accumulate and require a future storage/retention policy. A damaged retained content-addressed copy or malformed journal/decision may require manual repair; neither is silently replaced or discarded. A mixed choice can produce an invalid project manifest or inconsistent history, so opening the selected result must report validation errors truthfully without deleting its backups.

Process-kill checks do not establish power-loss durability, network-filesystem guarantees, a lock against hostile concurrent filesystem mutations, or supported-macOS acceptance. Project replacements remain individually atomic; another program may observe intermediate files.
