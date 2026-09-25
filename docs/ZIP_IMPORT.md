# ZIP project import

Use **… → Import ZIP project…** (also in the native File menu). Pick a ZIP, review the source/asset counts and skipped files, choose the main TeX document, then choose a parent folder. Folio creates a new, uniquely named child folder and opens it in Chat. It does not extract over an existing project.

**… → Open project folder…** opens an ordinary project folder. When it contains several TeX files, Folio offers the main-document chooser and retains a valid saved selection.

## Preserved content

- Source: `.tex`, `.sty`, `.cls`, `.bib`, `.txt`, as UTF-8.
- Assets: `.png`, `.jpg`, `.jpeg`, `.pdf`, `.otf`, `.ttf`, `.eps`, copied byte-for-byte. Support for copying an asset does not imply support for an external converter or every font/package.
- A single outer project folder is removed when all non-hidden entries share it. Relative subfolders remain intact.
- Folio manifest name, valid main-file selection, revision and supported template are retained. Each import gets a fresh project identity, including a rewritten conversation archive, so importing the same ZIP twice does not share local history.
- Saved conversations, drafts, PDF annotations and immutable source/PDF versions round-trip through `resume.folio`. Every archived snapshot is verified before extraction.
- Removed source files and earlier saved copies round-trip through the validated `resume.trash` archive.
- Hidden files, macOS metadata, known build/dependency directories and unsupported file types are listed as skipped before import. They are not silently copied into the project. The original ZIP remains unchanged.

## Archive boundary

`electron/core/safe-zip.ts` reads normal stored/deflated ZIP files. It parses and validates the central and local headers before inflating. Inflation has a hard output limit independent of the stream's actual contents; actual output length, consumed compressed bytes and CRC-32 must agree with the directory. Paths are checked before any filesystem mutation.

The reader rejects traversal, absolute/drive paths, backslashes, Windows device names, ambiguous case/Unicode names, duplicate names, file/folder collisions, symlinks/special files, overlapping records, inconsistent headers and corrupted/truncated data. It applies the same filename rules on each platform. Encrypted, split, ZIP64 and self-extracting archives are unsupported. Non-ASCII filenames require the standard ZIP UTF-8 flag.

| Bound | Limit |
| --- | --- |
| Compressed project ZIP | 136 MiB |
| Expanded outer ZIP, including history, saved copies and skipped entries | 136 MiB |
| Outer ZIP records, including folders/skipped files | 1,000 |
| Imported source + asset files | 200 files / 25 MiB total |
| Source | 100 files / 5 MiB total / 2 MiB per file |
| Manifest | 64 KiB |
| Saved file copies | 100 copies / 2 MiB per copy / 10 MiB serialized data |
| Included conversation archive | 100 MiB compressed / 200 MiB expanded / 2,001 entries / 25 MiB per entry / 1,000 versions |

Only one pending ZIP is retained, for up to ten minutes. It is held in the main process; the renderer receives an opaque token and a bounded preview. Cancelling creates no project files. Once a location is chosen, import uses a separate durable copy journal described below. An ordinary write failure removes the new copy only when its inventory still matches; outside edits block cleanup and remain available for review. Existing projects are never a cleanup target.

The existing unsaved-change guard runs before import. The modal stays open while importing and cannot be dismissed midway with Escape. A normal window close waits for the import and records the new project for recovery. Recent-project refresh no longer re-runs the full compiler integrity scan.

## Verification

`tests/zip-import.test.ts` covers normal compressed/stored/streamed ZIPs, UTF-8 paths, archive corruption, malformed headers, traversal/link/collision attacks, declared-versus-actual expansion bounds, source limits, cancellation, injected disk failure, existing-folder preservation, asset bytes, fresh identity and history round-trip. It also rejects a selected directory/symlink/named pipe without blocking for pipe input. These brought the unit/protocol suite to 61 passing tests on the development Mac.

`scripts/test-import.mjs` runs the real Electron UI, IPC, filesystem, compiler, PDF viewer and history. It checks a rejected unsafe ZIP, unsaved-change protection, main-file selection, cancelled destination, relative-input compilation, preserved assets/original files, source ZIP export/re-import, draft/history independence, folder opening, small-window dark/light screens and close-during-import behavior. The final run and packaged artifact evidence are recorded in the release README.

The final packaged import test passed in `test-results/import-NHWUVy/`; full packaged chat regression passed in `test-results/chat-ytxzzW/`, including the replacement bounded history reader. Both recorded zero renderer errors. Screenshots of the final compact dark/light import dialog and chat workspace were inspected. Artifact hashes are in `release/project-import/README.md`.

Apple silicon macOS-version archive compatibility and large-archive responsiveness measurements remain open. Windows, Linux and Intel Mac are outside the requested scope.

## Interrupted imports

For a step-by-step walkthrough, see [Finish an interrupted ZIP import](tutorials/recover-an-import.md).

After an unexpected close, a small header notice opens **Interrupted imports**. The same review is available from **… → Interrupted imports…** and **Settings → General → Review imports**.

- **Finish import** completes a partial copy from locally staged files. The original ZIP is not needed once staging has finished. Opening the recovered project uses the existing unsaved-changes choice for the current document.
- **Open recovered project** opens the same completed folder and keeps its project identity. It does not duplicate the project.
- **Move copy to Trash** uses macOS Trash for a verified unfinished folder. The currently open project cannot be trashed from recovery review.
- **Discard recovery copy** clears local staging when preparation did not finish or the destination folder no longer exists.
- **Keep files & dismiss…** requires an explicit second choice and removes only Folio's recovery record/staged files. It preserves the destination as it stands, including outside edits. The original ZIP is needed to retry after dismissal.
- **Show folder** appears when a destination exists. Folio verifies the recorded folder before revealing it in Finder.

Preparation first records the destination parent identity and the intended file inventory, then writes and flushes staged payloads. Copying starts only after staging completes. Every payload has a SHA-256 digest; each completed destination file is verified and recorded before the next begins. Recovery accepts an exact staged file or the matching prefix of the one uncommitted write. It rejects outside edits, missing/truncated completed files, new files, symlinks, hardlinked destination files and replaced directories. Missing previously owned folders are never silently recreated. A recorded discard intent prevents an interrupted Trash operation from becoming a resumed import.

Recovery records live in Folio's app-data `import-transactions/` directory. Admission is limited to 10 pending records and 512 MiB of reserved staged bytes. Individual imports retain the existing 136 MiB inventory bound. A completed record is acknowledged only after the renderer has saved local recovery and loaded the new project. A failed acknowledgment leaves a reviewable copy. The review stays open while busy; ordinary window close waits for completion and then flushes recovery.

`tests/import-recovery.test.ts` uses actual SIGKILL at staging, prepared, directory-created, partial-file, completed-file, complete and discarded boundaries. It verifies resume, safe cleanup, retained external edits/links/replaced folders, corrupt journals/payloads, record limits, Unicode folder names and refused-removal state. `scripts/test-import-recovery.mjs` exercises the real Mac UI, compiler and PDF with synthetic projects: dirty-document protection, partial/completed recovery, outside edits, failed acknowledgment, open-project Trash refusal, small-window dark/light review, all three entry points, close during resume and restart. The native test intercepts Trash with a test-directory rename; it proves the application calls the native API with the verified path, not the operating system's Trash implementation itself.

The native test reproduced a same-project reopening bug: the app cleared compiler readiness without rerunning the readiness check because the project ID/pin stayed the same. Every open now triggers that check through its editor session. The retained failure is `test-results/import-recovery-727XTY/`; the corrected source suite passed in `test-results/import-recovery-6TTDJD/` without renderer errors. Source normal-import/chat regressions also passed in `import-3lCzRl/` and `chat-X7ZRky/`. Exact packaged evidence is recorded in the milestone's release README when qualification finishes.

Process-kill tests establish interrupted-process recovery on this development Mac. Power-loss durability, network filesystems and arbitrary concurrent same-user filesystem attacks require separate acceptance; path checks and fsync are not evidence of those broader guarantees.

The file-management package reran the full import suite in `test-results/import-hwx0nF/` and the chat suite in `test-results/chat-HpDWmb/`, both with no renderer errors. `tests/file-management.test.ts` additionally verifies nonempty saved-copy ZIP import, and `test-results/files-YbAyZY/` verifies nonempty native source export. Current build hashes are in `release/file-management/README.md`.

The external-change package passed import in `test-results/import-jJWpxu/`, files in `test-results/files-b0YvJF/`, chat in `test-results/chat-5QYOCQ/` and outside-file review in `test-results/watch-TMBtBE/`, all without renderer errors. The import test now waits for the import dialog to close before reading the new folder, rather than treating matching draft/PDF content from the previous project as completion. Saved-copy archives accept the new `editor-copy` reason under the same limits. The current unit/protocol suite has 80 passing tests; current build hashes are in `release/external-changes/README.md`.
