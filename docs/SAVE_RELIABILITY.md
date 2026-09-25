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

The later file-management work extends the same journal to deletion entries. Tests cover rollback after a deletion and a real process kill after a source file is removed, plus preservation of both unsaved buffers and newer disk bytes. See [file management](FILE_MANAGEMENT.md). The current unit/protocol suite has 80 passing tests.

[External-file watching](EXTERNAL_CHANGES.md) compares both source and assets against the accepted disk baseline. Scans wait for complete saves. Reload writes preserved editor buffers and the new accepted source/asset baseline to recovery before publishing the result. Source replacement after an explicit save-conflict choice retains differing outside UTF-8 text in `resume.trash`; storage limits and invalid text fail before writing any file. Metadata/history conflicts remain pending after a source reload.

## Limits

This provides crash-recoverable application consistency, not a filesystem primitive that atomically exposes many ordinary files to every external process. An outside editor can observe individual replacement steps. External changes are detected before replacements and recovery, but hostile concurrent filesystem mutation is not a portable lock guarantee.

Process-kill recovery is tested on the development Mac. Power-loss behavior, network filesystems, Windows/Linux directory-flush behavior and native installer upgrades still need target-platform validation. The app does not promise survival of damaged storage or unavailable backups. Empty directories created before a failed save may remain; original file bytes and user edits are protected.

Journals and backups live in application data and follow its local permissions; they are not encrypted. Recovery after a conflicting external edit currently gives the affected path and preserves backups for manual resolution. A guided recovery/conflict UI remains future release work.
