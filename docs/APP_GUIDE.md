# Folio — local LaTeX resume studio

A desktop workspace where you can chat about your resume, mark changes on its PDF, and let an AI update the LaTeX. Chat is the main view; the Code tab remains available for direct editing. PDF compilation happens locally. AI is optional and uses a connection you choose in Settings. This is a working **0.1 development preview**, not the full production release described in [the project plan](../PROJECT_PLAN.md).

## What works

- Chat beside the real PDF, with the existing file sidebar and a secondary Code tab.
- Chat model selection with Auto and manual choices; connection setup in Settings: installed Codex/Claude Code subscriptions, OpenAI/Anthropic API keys, and compatible custom endpoints.
- An agent that reads source and PDF images, proposes edits in a separate copy, builds locally, and checks every output page before applying changes.
- PDF highlights, boxes, freehand marks, and notes. Attach selected marked areas to a message, including their page and source context.
- Persistent conversations, drafts, notes, and matching source/PDF versions; compare, restore, undo, stop, and protection for newer manual edits.
- Six original templates: Classic, Modern, Academic, Minimal, Compact Technical, and Two Column. Each supports A4 and US Letter, with real PDF thumbnails and bundled-font details.
- CodeMirror editing, syntax highlighting, command completions, search, per-file undo/redo across tabs, and section snippets.
- Dark and light themes, a header toggle, and a saved System appearance option in Settings.
- Compact workspace with resizable file/writing/PDF panes, remembered proportions, keyboard dividers, a collapsible sidebar and narrow PDF gutters. Project menus retain all secondary actions.
- New source files, recoverable rename/removal/restore, main-document selection, and opening existing `.tex` projects with relative assets.
- Automatic/manual local compilation, cancellation, timeouts, and source-linked diagnostics.
- Reviewable support ZIPs with section controls and fixed diagnostic summaries. Source, logs, paths and credentials are excluded; nothing is uploaded. See [support bundles](SUPPORT_BUNDLES.md).
- Guided local OTF/TTF selection, real PDF preview and journaled source/font saves. Font files travel with Save As and source ZIPs. See [local fonts](LOCAL_FONTS.md).
- Plain-language help for recognized missing packages, files, fonts and engine requirements, with the original errors and raw log preserved. See [compiler error help](BUILD_HELP.md).
- PDF preview with selectable text, links, page navigation, zoom, and preservation of the last successful PDF after errors. Documents up to 100 pages and 25 MiB use visible-page rendering, bounded canvases and timed worker cleanup; see [viewer limits](PDF_VIEWER_LIMITS.md).
- Native save/Save As, optional autosave, external-file watching with review and preserved copies, PDF export, and source ZIP export.
- Safe ZIP project import with main-file selection, preserved chat/PDF history, fresh project identities, and ordinary folder opening.
- Journaled multi-file saves with rollback after write failures or interrupted saves, protected external edits, and recovery flush before closing the window.
- A bundled compiler and locked local resources. Included templates compile with a fresh cache and network access denied.
- Recorded compiler versions retained across app updates, with verified offline repair in Settings. Saves, recovery and exported projects keep their compiler choice.
- Explicit compiler comparison in Settings: view both real PDFs, keep a full source/asset/history backup, and apply the included compiler only after review. See [compiler migration](COMPILER_MIGRATION.md).
- Common imported XeLaTeX resume packages, Roboto/Source Sans Pro fonts, Font Awesome icons, and local Biber bibliography processing on macOS.

## Platform status

The requested release is **macOS Apple silicon only**. Windows, Linux and Intel Mac are outside the current goal.

| Platform | Status |
| --- | --- |
| macOS Apple silicon | Compiler, desktop workflows, and local app packaging tested on this development machine |

macOS compiler isolation currently uses `sandbox-exec`/Seatbelt. It must be reviewed against supported OS versions and the eventual signed-helper distribution design. There is no unsandboxed fallback.

## Run from source

Developer prerequisite: Node.js 24 with npm. End users of a packaged build do not need Node.js or a separate LaTeX installation.

The latest verified Apple silicon build is in `release/import-recovery/mac-arm64/Folio.app`; its disk image is `release/import-recovery/Folio-0.1.0-mac-arm64.dmg`. It adds crash recovery and review for interrupted ZIP imports, preserves outside edits, and fixes compiler readiness when reopening the same project. Chat, PDF annotations, six templates, bounded PDF rendering, resizable panes, autosave, journaled saves, outside-file review, compiler comparison and offline repair remain available. Earlier milestone builds are retained. Save your work and quit Folio before opening or installing the new build. These contain the runtime and template resources and are unsigned development artifacts. The exact local qualification is summarized in [implementation status](IMPLEMENTATION_STATUS.md).

```sh
npm ci
npm run setup
npm run dev
```

`setup` downloads the pinned Electron/Tectonic runtime, Biber on macOS, and the pinned template resources. It needs internet access on the developer machine. Preparation validates archive checksums, resource hashes, and fresh-cache offline compilation before succeeding.

If the runtime is already prepared, use `npm run dev` directly. Main-process changes require restarting the command; renderer changes reload automatically.

To run production assets:

```sh
npm run build
npm start
```

`npm run dev:web` provides an interface-only browser preview. Native file access and compilation require Electron; browser mode does not simulate successful compilation.

## Use the app

1. Choose a paper size and template, or open the main `.tex` file of an existing project.
2. Open **Settings → AI connections** to add and select a connection. You can use the Code tab and local compiler without an AI connection.
3. In Chat, describe the change you want. Enter sends; Shift + Enter starts a new line. The agent reads, edits, builds, and checks the PDF. Stop cancels the request.
4. Use the tools above the PDF to highlight, draw a box, sketch, or leave a note. Select notes and use **Attach to chat**, then send your request.
5. Use **Compare changes**, **Undo**, or **History** to inspect saved versions. If you edited the source during an AI request, its finished draft stays in History instead of replacing your edits.
6. Use **Save** to write the project folder. **Save project as…** makes an independent copy with its chat and history. **Export PDF** exports the current successful build without chat or marks, recompiling current edits first when necessary.

Drag a pane divider to resize the workspace, or focus it with Tab and use Left/Right. Enter resets that divider; **Settings → General → Reset pane sizes** resets both. Sizes are remembered.

**Settings → General → Autosave project** is off by default. After your first Save chooses a folder, it can save source, chat and notes after a two-second pause. It waits during AI work, dialogs and other saves, and pauses for outside changes or errors. Recovery still works with autosave off. See [workspace behavior and tests](WORKSPACE_PREFERENCES.md).

For manual editing, switch to **Code**. Leave auto-compile enabled, or press **Compile** (`Cmd/Ctrl+Enter`). Add sections before `\end{document}`. For multiple files, add `\input{sections/experience}` to the main file.

Templates shows the actual sample PDF for your selected A4 or US Letter size. The listed fonts are bundled. To change an existing bundled resume's paper, edit `a4paper`/`letterpaper` in its `\documentclass` line and rebuild. See [templates, fonts, and corpus checks](TEMPLATES.md), including the one-page limitation of the two-column layout.

Use a file's **…** button to rename or remove it; Save writes the change to disk. **… → Removed files & saved copies…** restores removed text under an available name. Earlier disk copies are retained when saving a removal. Each file keeps its own undo history during the editing session, including across Chat/Code and Save As. See [file management and limits](FILE_MANAGEMENT.md).

If another app changes the project folder, choose **Review changes** above the workspace. Keep editing, save a separate copy, or reload the source from disk. Reload preserves differing editor text in **Removed files & saved copies** before replacing the buffers. Builds, AI requests and exports wait for source/asset review; a finished AI draft also checks the folder before applying. See [outside-file changes and limits](EXTERNAL_CHANGES.md).

A failed build keeps the previous PDF visible and marks it out of date. Errors appear below the editor. Exports of changed source require successful recompilation. Export also waits for the current preview to render; a rejected or timed-out PDF keeps export paused. The local viewer supports up to 100 pages and 25 MiB, while AI image review has its separate 20-page limit.

Folio starts in dark mode. Use the sun/moon button in the header to switch themes, or choose **Settings → General → Appearance → System** to follow your operating system. Your preference is saved. PDF pages keep their original paper colors in either theme.

Settings also contains compiler details, privacy information, and the app version. The workspace shows a runtime alert only when the compiler needs attention or native features require the desktop app.

Use **Settings → About → Repair compiler** if the recorded compiler is damaged. Repair checks a separate replacement before activating it and keeps your draft and compiler choice intact. If no matching local copy is available, editing and saving still work; the app does not silently use another compiler. See [recorded compilers and repair](RUNTIME_MANAGEMENT.md).

Use the **…** menu beside the project name for folder opening, ZIP import, Save As, source ZIP export, recent projects, templates, section insertion, main-document selection, and Help. The sidebar keeps compact shortcuts for these editing tools. Its folder tree and tabs retain every source file; both keep the active file visible as the window resizes. Click the bottom error/warning count to open diagnostics and the raw build log. Changing the main document does not change the file being edited.

Supported imported text files: `.tex`, `.sty`, `.cls`, `.bib`, `.txt`. Copied assets: PNG, JPEG, PDF, OTF, TTF, EPS. Symlinks and references outside the project folder are rejected. EPS-dependent external tools are not included merely because the asset can be copied.

For a ZIP, choose **… → Import ZIP project…**, select its main TeX document, review any skipped files, and choose where to keep the new project folder. Existing projects and the original ZIP remain unchanged. Saved chat and PDF history come with Folio exports; each import receives a new identity. Cancellation creates no files. Imports accept ordinary stored/deflated ZIPs within explicit limits and reject unsafe paths, links, duplicate names and excessive expansion. See [ZIP import behavior and limits](ZIP_IMPORT.md).

## Connect your AI

All connection and model choices live in **Settings → AI connections**. Saving a connection does not select it automatically: choose its radio button to use it for your next message. Existing requests keep the connection with which they started.

- **Codex subscription:** install the official Codex command and sign in with your subscription. Folio uses its app-server and an isolated, read-only conversation with tools disabled. Leave Model blank for the account default, or check the connection and choose an image-capable model. An optional absolute app location supports installations outside the usual command paths.
- **Claude Code subscription:** install the official Claude Code command and sign in to your Claude account. Folio uses its normal subscription sign-in and print mode with tools and customizations disabled. Folio does not extract subscription tokens.
- **API keys:** choose OpenAI or Anthropic and enter your own key and image-capable model ID. API usage is billed separately by your provider.
- **Custom connection:** enter a base URL, optional key, model, and supported format: OpenAI Responses, OpenAI Chat Completions, or Anthropic Messages. HTTPS is required except for local endpoints.

Use **Check connection** and **Test image support** after setup. The image test sends a small sample, not your resume; provider usage may apply. Choose a model that accepts images so the agent can review PDF pages. Keys use the operating system's protected storage and are excluded from project exports. If protected storage is unavailable, saving a key fails instead of storing plaintext.

When you send a message, the selected connection receives your message, source files, recent conversation context, PDF page images, and selected notes. Notes from earlier versions include the matching earlier source and PDF images. Projects and chat history are otherwise local and are not encrypted by Folio. Source ZIPs and the `resume.folio` file include chat and version history, so share those intentionally.

The installed Codex connection and a real synthetic image request were verified on this development Mac. Claude Code's protocol is fixture-tested; the installed command reports signed out, so a live Claude subscription edit has not been verified. API formats have local protocol tests and the custom API path has a packaged desktop workflow test; live OpenAI/Anthropic API billing accounts were not used in tests.

## Current chat limits

- Each request can include up to 30 selected notes. Visual review covers every page, up to 20 pages and an 8 MB image-data budget. Oversized inputs stop with a message instead of silently skipping pages.
- The agent makes at most three edit/build/review attempts. Failed or cancelled requests leave your source and last good PDF available. AI factual accuracy still needs your review; missing-fact handling is instructed and tested, not a guarantee about every model response.
- Chats retain up to 2,000 messages and 2,000 notes within an 8 MB workspace record. Versions are local source/PDF snapshots; project history archives are limited to 1,000 versions, 200 MB expanded, 100 MB compressed, and 25 MB per entry.
- A version preserves source and the exact PDF, not older image/font assets. Restoring rebuilds with the project's current assets. PDF marks belong to their exact saved PDF; recompiling can create a new version even when the source text is unchanged. Earlier marks remain accessible in History and sent messages.
- Save As is unavailable while an AI request is running. Interrupted requests are shown after restart and are never automatically resumed.

## Saving and interrupted saves

Save prepares source, copied assets, project details, and chat/history before changing the project folder. If a write fails, Folio restores the previous files. After an unexpected process exit, it checks the save journal before reopening or using the project. A completed save stays completed if cleanup is interrupted.

If a file was edited outside Folio after the interruption, recovery stops and keeps both the external edit and its backups. The message identifies the file and backup folder for resolution. Save As keeps the workspace briefly inactive while creating the copy; closing waits for the save. Only one Folio process may use the same app profile at once.

These checks are verified for process interruptions on this Mac; they are not a power-loss or damaged-storage guarantee. See [save reliability and test evidence](SAVE_RELIABILITY.md).

## Offline runtime

The resource bundle contains 516 locked resources, approximately 10 MB compressed. macOS also includes Biber 2.17 and its pre-expanded Perl dependencies, matching the bundled BibLaTeX version. End users need no separate TeX, Perl, Biber, or developer tools for local compilation. Subscription AI connections use the separately installed official provider command.

`scripts/runtime-config.mjs` pins compiler archive checksums and the upstream bundle digest. `resources/bundle.lock.json` pins packaged resources. `runtime:prepare` collects resources for the template corpus and authored compatibility fixture, packages exactly the locked set, and verifies each with a new cache and only the local ZIP. `runtime:verify` repeats integrity and offline checks without package downloads. Production compilation keeps the runtime read-only, places Biber's cache lock in the temporary build directory, and allows execution only of the bundled engines.

First launch prepares a verified app-owned compiler copy and runs an offline self-test. Existing projects retain their recorded compiler when the app changes. Local repair restores the exact version from matching installer files or a retained verified copy. See [runtime persistence, repair and limits](RUNTIME_MANAGEMENT.md).

This is a template-corpus bundle, not a complete TeX Live distribution. The compatibility fixture covers Russell-style package imports, compact math-font sizes, icons, and an actual BibLaTeX/Biber bibliography. Other imported templates may still need absent packages, fonts, or engines. Package downloads during compilation, online repair/expansion packs, a full TeX Live compatibility pack, and shell-escape workflows are not implemented. Explicit compiler comparison and migration are available in Settings.

Maintainers can deliberately update the lock after changing the trusted template corpus:

```sh
node scripts/prepare-runtime.mjs --update-lock
```

Review the inventory and redistribution requirements before publishing a new bundle. Do not run preparation on untrusted documents.

## Test and build

```sh
npm run typecheck
npm test
npm run test:integration
npm run test:desktop
npm run test:compact
npm run test:chat
npm run test:import
npm run test:import-recovery
npm run test:files
npm run test:watch
npm run test:templates
npm run test:workspace
npm run test:pdf-lifecycle
npm run test:pdf-viewer
npm run test:runtime
npm run test:migration
npm run format:check
npm run pack
```

- Unit tests cover path validation, save conflicts, recovery, assets, fingerprints, diagnostics, AI protocols and history. Save-journal tests kill a child process at real save/rollback boundaries and check that reopening restores a consistent project without overwriting later external edits.
- macOS integration tests run the real compiler, verifying offline builds, outside-file restrictions, network denial, cancellation, timeouts, multi-file builds, and stale-export prevention.
- Desktop tests launch Electron, edit source, exercise errors, intercept native dialogs into test directories, save/export, and verify close/reopen recovery.
- Compact-layout tests exercise relocated actions, grouped files and duplicate basenames, main-document selection, diagnostics jumps, snippets, Save As/source ZIP, unsaved guards, all templates, stop, PDF navigation/zoom, menu keyboard focus, theme/undo preservation, and controls at the minimum window size with 18px editor text. A separate isolated fixture verifies missing-runtime and empty-preview states plus native Save without a compiler.
- Chat tests use a local AI protocol fixture with the real Electron app, protected key store, compiler, PDF renderer, and version store. They cover every annotation tool, selected image crops, all-page review, checked edits, stale/cancelled requests, questions, retry, compare/undo/restore, independent Save As history, clean exports, restart recovery, and the minimum window size. Run against a packaged build with `node scripts/test-chat.mjs /absolute/path/Folio.app/Contents/MacOS/Folio`.
- Import tests cover unsafe ZIP rejection, unsaved-change guards, selection/cancellation, real relative-input compilation, byte-for-byte assets, export/re-import with independent history, folder opening, compact dark/light screens and close-during-import recovery. Run against a packaged build with `node scripts/test-import.mjs /absolute/path/Folio.app/Contents/MacOS/Folio`.
- File-management tests cover independent file undo/redo, rename/removal/restore, long names, conflict choices, earlier disk copies, Save As, ZIP contents, new files and restart recovery. Run against a packaged build with `node scripts/test-files.mjs /absolute/path/Folio.app/Contents/MacOS/Folio`.
- Watcher tests cover outside additions/edits/removals, review and reload, preserved buffers, asset-only stale PDFs, native stale-export rejection, Save As, restart, metadata conflicts and compact light/dark dialogs. The chat suite checks both reported and delayed outside edits during inference. Run against a packaged build with `node scripts/test-watch.mjs /absolute/path/Folio.app/Contents/MacOS/Folio`.
- Packaged smoke test: `node scripts/test-packaged.mjs /absolute/path/Folio.app/Contents/MacOS/Folio`.
- Template tests create all six layouts at both paper sizes, inspect PDF text and exported dimensions, preserve origin metadata through save/restart/ZIP, and check keyboard selection and the compact picker. `npm run templates:build` regenerates actual thumbnails and runs text/font/layout checks; see [prerequisites and evidence](TEMPLATES.md).
- Workspace tests exercise pointer/keyboard resizing, minimum widths, preference persistence, actual autosave writes, typing during a save, conflicts, rollback/retry, native project selection and close/restart recovery. The chat suite also verifies autosave deferral during AI work. Run native UI suites sequentially to avoid competing test-window focus.
- PDF viewer tests exercise real 35-/100-/101-page documents, distant-page notes, canvas budgets, mixed page geometry, rejected PDFs, stalled loads/renders, actual worker termination and export recovery. The lifecycle suite separately checks delayed replacement while resizing. See [bounds and evidence](PDF_VIEWER_LIMITS.md).
- Isolation tests must run outside a parent sandbox that prohibits `sandbox-exec`.
- Runtime tests check exact compiler selection, damaged-file rejection, offline repair, saved/source-export/history pins and restart using an isolated profile. Run against a packaged build with `node scripts/test-runtime.mjs /absolute/path/Folio.app/Contents/MacOS/Folio`.

Tests use temporary directories and `test-results/`. Set `FOLIO_USER_DATA` to isolate a development/test workspace. Normal installs use Electron's platform-standard application data directory.

## Packaging

`npm run pack` creates the Apple silicon Mac app directory. `npm run dist` produces the Mac disk image and update ZIP. Both commands explicitly target macOS arm64; Windows, Linux and Intel Mac packaging are outside this goal.

For a local macOS preview without selecting a distribution signing identity:

```sh
CSC_IDENTITY_AUTO_DISCOVERY=false npm run pack -- --mac --arm64
```

Public distribution still requires signing/notarization, complete license materials, OS-version testing, installer/upgrade tests, and handling of binary signing in runtime integrity manifests. The app has no automatic updater.

## Repository

```text
src/                         Chat, settings, editor and PDF feedback
electron/main.ts             Window, dialogs, validated IPC
electron/preload.ts          Narrow renderer API
electron/core/               Projects, AI providers, agent, versions, compiler
resources/templates/         Original LaTeX templates
resources/bundle.lock.json   Pinned resource inventory
scripts/                     Runtime preparation and desktop tests
tests/                       Unit and compiler integration tests
```

User projects are ordinary LaTeX files plus `resume.project.json` and `resume.folio` for conversation/history. Recovery lives in app storage. Source ZIPs contain source/assets, the manifest, and conversation/history, excluding caches and AI credentials.

See [chat implementation evidence](CHAT_FIRST_IMPLEMENTATION.md), [implementation status](IMPLEMENTATION_STATUS.md), [the full plan](../PROJECT_PLAN.md), and [third-party notices](../THIRD_PARTY_NOTICES.md).

## Community delivery and licensing

Original Folio source and documentation use [PolyForm Noncommercial 1.0.0](../LICENSE), with the [required notice](../NOTICE). This is a noncommercial, source-available project. Third-party components keep their own licenses; see [licensing scope and remaining redistribution work](LICENSING.md).

The public [grawish/folio repository](https://github.com/grawish/folio) contains the source. Start with [your first resume](tutorials/first-resume.md), browse the [22 screenshot walkthroughs](FEATURE_GUIDE_INDEX.md), or install the [documentation skill](DOCUMENTATION_SKILL.md). The [release pipeline](RELEASE_PIPELINE.md) distinguishes source prereleases, Mac candidate qualification and the remaining production installer work.


The [performance investigation and optimization plan](PERFORMANCE_IMPROVEMENT_PLAN.md) includes three measured backend runs and their raw evidence. It identifies runtime-copy/self-test cost during first setup and verification cost during small warm builds. Full app, AI, storage and reference-device measurements remain open.
