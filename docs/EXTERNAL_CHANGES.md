# Changes made outside Folio

Folio watches the open project folder. If another app adds, edits, replaces or removes a source file, image, font or project-data file, a notice appears above the workspace. Your editor text stays in place. Choose **Review changes** to see the affected paths.

## Choices

- **Keep editing** closes the review without changing either version. Saving still asks before replacing changed source or project data. An explicitly approved source replacement keeps the outside UTF-8 text in **Removed files & saved copies**.
- **Reload source from disk** reads all current source files and accepts the current assets. Every differing editor buffer, including an unsaved new file, is kept as an **Earlier editor copy**. Reload does not write the project folder. Save persists the resulting source and saved copies.
- **Save a copy…** creates an independent project with your current editor text and the folder's current assets. The original folder is preserved.
- **Check again** refreshes the report. If the folder changed after the reviewed snapshot, reload refuses that outdated snapshot and asks for another check.

The main document after reload must be an existing `.tex` file. Reload is unavailable when none remains, a file cannot be read safely, or the project exceeds its limits. Stop a running AI request before reloading. A full saved-copy archive or failed recovery write leaves the editor and accepted disk state unchanged.

Reload accepts source and assets only. Changes to `resume.project.json`, `resume.folio` or `resume.trash` remain visible and still require the normal save conflict choice before replacement. Histories and saved-copy archives are not automatically merged. Save a copy retains the original project folder and its outside data.

## PDF and AI behavior

Unreviewed source/asset changes make the displayed PDF stale and block new builds, AI requests and exports. These checks also run in the native service. The last successful PDF remains visible.

Reload advances the project revision even when only an asset changed. The old PDF cannot be exported as current; it must be rebuilt. The native PDF cache requires both matching source and matching revision.

A completed AI draft is applied only if the editor and disk state still match the starting state. Folio checks the folder again before applying it, so this protection also works when a native file notification is delayed. A checked draft that loses this comparison stays in History; it does not replace current editor text.

## Detection and recovery

Native recursive file notifications are debounced by 250 ms. A reconciliation also runs every four seconds, including when native watching is unavailable. Only the authorized current project folder is watched; switching projects, Save As, closing the window and quitting update or stop the watcher.

Reconciliation traverses the folder and compares hashes against the last opened, saved or explicitly accepted contents. Unchanged files reuse hashes keyed by device, inode, size and nanosecond modification/change times. Reload performs a fresh hash of every recognized file. Own saves and scans share the project operation queue, so a scan cannot mistake a partial Folio transaction for an outside edit.

Before reload changes the editor or accepted baseline, Folio writes both the new source and all retained editor copies to local recovery. Restart therefore recovers that decision even before Save. Missing folders and unreadable files produce a visible error rather than an up-to-date result.

The scanner follows the existing project rules: no visible symbolic links, at most eight folder levels, 5,000 encountered entries, 200 source/asset files and 25 MiB total; source is limited to 100 files, 5 MiB total and 2 MiB per file. It ignores hidden entries, `node_modules`, `build`, `dist` and unsupported regular files. Source must be valid UTF-8. Metadata/history/saved-copy files have their existing separate limits. The watcher retains source text and hashes, not additional binary asset copies.

## Verification and limits

`tests/project-watch.test.ts` covers atomic replacements, nested additions/removals, own saves, assets and metadata, reload and restart, original editor copies/BOMs, stale review tokens, missing main files, full copy storage, failed recovery writes, invalid UTF-8, links, traversal limits, missing/restored folders, watcher switching and scan/save ordering.

`scripts/test-watch.mjs` exercises the real native UI, filesystem, recovery, compiler and PDF: review choices, compact light/dark dialogs, preserved editor copies, save conflicts, outside-source backups, stale asset/export protection, missing main files, Save As, project switching, restart and metadata-only changes. `scripts/test-chat.mjs` also verifies outside changes during real compile/review and repeats that case with watcher notifications suppressed.

Development runs passed in `test-results/watch-M2VaUU/`, `test-results/chat-J8kAZa/`, `test-results/files-tnw452/` and `test-results/import-YUNMEY/`. All recorded zero renderer errors. The full unit/protocol suite has 80 passing tests; all 10 native compiler integration checks, TypeScript, build and formatting passed. Packaged evidence is recorded in the release README.

Final packaged runs passed in `test-results/watch-TMBtBE/`, `test-results/chat-5QYOCQ/`, `test-results/files-b0YvJF/` and `test-results/import-jJWpxu/`, all with zero renderer errors. The unsigned app and disk image are in `release/external-changes/`; its README records their hashes and remaining release scope.

This is tested on the Apple silicon development Mac. Periodic scanning is not a portable lock against hostile concurrent filesystem mutation, and network-filesystem and supported macOS-version acceptance remain release work. Recovery from an interrupted multi-file save that conflicts with a newer outside edit uses the separate [guided save recovery review](SAVE_RECOVERY_IMPLEMENTATION.md), which preserves file versions and unsaved drafts before applying choices.
