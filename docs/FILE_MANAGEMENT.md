# Source files and editor history

Use the **…** button beside a source file, right-click its row, or choose **… → Rename or remove current file…**. The normal Save button writes the change to the project folder. Before Save, the folder still has its original files and local recovery keeps the edited project.

## Rename and remove

- Rename accepts a relative source path, including a new subfolder. Renaming the main document updates the main-file selection. References such as `\input{old-name}` in other source files must be updated by the user.
- Remove moves the current editor contents to **… → Removed files & saved copies…**. Removing the main document requires choosing another `.tex` document. Folio cannot remove the last main document.
- Save writes the new files, metadata and saved-copy archive before removing old paths. The save journal covers both writes and removals. A failure or interrupted save restores the earlier bytes before the project is reopened.
- If the removed disk file differs from the saved editor copy, Folio also keeps its exact UTF-8 contents, including a byte-order mark when present. A newer external edit triggers the normal conflict choice first. Keeping the disk version cancels the save; explicitly replacing it retains that external text as an earlier saved copy.
- Only source paths registered with the open project are removal targets. Assets and untracked files are not removed by this operation.

## Restore and storage

The saved-copy list labels current removed buffers as **Removed file**, copies captured while saving as **Earlier saved copy**, and buffers preserved when reloading outside edits as **Earlier editor copy**. Select Restore to preview the text and choose a filename. Restore rejects an existing name instead of overwriting it. **Delete saved copy** has its own confirmation; save the project to persist that choice. Other source files and PDF versions remain available.

`resume.trash` is a versioned JSON file in the project folder. It is included in recovery, Save As and source ZIP exports/imports. It is local and unencrypted, just like source and conversation history. A PDF export does not include it. New PDF history checkpoints store active source, without duplicating the whole saved-copy list on every build.

Limits are 100 saved copies, 2 MiB of UTF-8 source per copy, and 10 MiB of serialized copy data. Nothing is silently pruned when full: restore or delete specific saved copies to make room. Restoring must also fit the normal 100-source-file / 5 MiB project limit. Invalid archives fail before a removal is written. Newly chosen names reject unsafe paths, reserved device names, file/folder collisions and ambiguous case/Unicode spellings. Use an intermediate name for a rename that changes only case or Unicode spelling.

## Undo

Each active project's file retains its own CodeMirror undo/redo, selection and scroll position across tab switches. Chat/Code, appearance changes, source renames and Save As preserve these editor states. Opening another project clears them, including when the new project uses the same filenames. Restoring a removed file restores its full text with a new editing history. Editor undo histories are session state; restart recovers source contents and saved copies, not the complete undo stack.

## Verification

`tests/file-management.test.ts` exercises rename/removal/restore, portable path collisions, capacity checks, original and unsaved contents, a UTF-8 byte-order mark, outside-file conflicts, malformed saved-copy data, rollback after deletion, a real child process killed after deletion, recovery, Save As and ZIP import.

`scripts/test-files.mjs` uses the native Electron app with synthetic projects and an isolated profile. It checks per-file undo/redo through tab, Chat, theme, rename and Save As changes; on-disk deletion after Save; last-main protection; restore collision handling; outside-edit conflict choices; saved-copy removal; source ZIP contents; restart recovery; and project history separation. The development run passed in `test-results/files-siFNxR/` with no renderer errors. Light/dark dialogs at the minimum window size were visually inspected.

The final packaged file-management test passed in `test-results/files-YbAyZY/`, including long-filename layout, new-file creation and project switching with identical source names. Full packaged chat and import suites passed in `test-results/chat-HpDWmb/` and `test-results/import-hwx0nF/`. All reported zero renderer errors. Hashes are recorded in `release/file-management/README.md`.

The full unit/protocol suite now has 80 passing tests. Target-platform and power-loss durability remain release work; see [save reliability](SAVE_RELIABILITY.md). [External-file watching](EXTERNAL_CHANGES.md) now preserves differing editor buffers during reload and outside text during an explicitly approved replacement. Optional autosave and resizable panes remain separate implementation tasks.

The newer external-change package reran file management in `test-results/files-b0YvJF/`, chat in `test-results/chat-5QYOCQ/`, import in `test-results/import-jJWpxu/` and the new watcher flow in `test-results/watch-TMBtBE/`. All passed without renderer errors. Current build hashes are in `release/external-changes/README.md`.
