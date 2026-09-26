# Implementation status — 0.1 development preview

The development app now adds the requested chat-first workflow to real editing, native filesystem operations, local compilation, PDF preview, and a packaged macOS application. The production plan remains incomplete, with the user’s latest scope restricted to macOS Apple silicon.

## Implemented

- Chat is the default center pane, with Code available as a secondary tab and the real PDF alongside it.
- Settings-only connection/model setup and selection for Codex subscriptions, Claude Code subscriptions, OpenAI/Anthropic API keys, and custom compatible APIs. Keys use OS-protected storage; native tools own subscription sign-in.
- A separate AI edit/build/review loop with full-page images, bounded retries, cancellation, missing-fact questions, and rejection of results that would overwrite newer manual changes.
- Version-bound highlight/rectangle/pen/note feedback, marked image crops, immutable note attachments in earlier messages, and old-version source/page context.
- Persistent chat, drafts, notes, matching source/PDF snapshots, compare/restore/undo, independent Save As histories, and interrupted-request recovery. Source exports include history; PDF exports remain clean.
- Electron/React/TypeScript scaffold, narrow preload bridge, IPC validation, sandboxed renderer, local resource protocol, and restricted navigation.
- Six LaTeX templates covering Minimal, Classic, Compact Technical, Academic, Two Column, and the existing Modern layout. The picker offers A4/US Letter, actual PDF thumbnails and bundled-font details. Origin versions survive save/recovery/history/ZIP; twelve-variant checks are recorded in [templates](TEMPLATES.md). CodeMirror editing, completions, file tabs, new files, main-file selection, and snippets remain available.
- Per-file session undo/redo across tab, Chat/Code, theme, rename and Save As changes. Recoverable source rename/removal/restore, original and unsaved copies, save-journal deletion recovery, saved-copy ZIP round-tripping and portable name/capacity checks. See [file management](FILE_MANAGEMENT.md).
- Persistent Dark/Light/System appearance, a header toggle, themed editor syntax and controls, and matching native dialogs. Theme changes preserve editing history and PDF paper colors.
- Simplified workspace: extra header labels, repeated privacy copy, motivational sidebar card, routine runtime card, and decorative footer removed. Privacy/version information and runtime details live in Settings, with a compact runtime alert shown only when needed.
- Compact workspace: 48px unified app header, 40px editor/preview control rows, a 24px status strip, grouped source files, and 8px PDF gutters. All secondary actions remain accessible through the project menu and compact sidebar; selected files stay visible when resizing.
- Immutable build directories containing unsaved buffers and supported project assets.
- Compilation with cancellation, stale-result rejection, output/log limits, timeout, and current-source export checks.
- Pinned Tectonic downloads, archive verification, resource lock, local ZIP bundle, integrity verification, and offline template checks.
- Exact per-project compiler identities persist through saves, recovery, history and source ZIPs. Verified local copies survive app updates; Settings offers offline repair with staging, self-test, atomic activation and leased-copy retention. Corruption and interrupted repairs are tested; see [runtime management](RUNTIME_MANAGEMENT.md).
- Imported resume compatibility: array, enumitem, layout packages, Roboto/Source Sans Pro fonts, Font Awesome icons, compact math fonts, and matching Biber 2.17. Biber dependencies remain read-only inside the compiler sandbox.
- macOS compiler restrictions denying networking and outside user-file access; no unconfined fallback on other platforms.
- Selectable PDF text/links, zoom/navigation, previous-preview preservation after failure. A displayed PDF stays alive while a replacement loads, allowing resizing without using a destroyed worker; annotations wait for matching bytes, and the stale notice stays clear of the toolbar.
- Visible-page rendering for PDFs up to 100 pages and 25 MiB, exact mixed-page layout, bounded canvas pixels including annotation overlays, load/render deadlines and owned-worker termination. A rejected initial replacement restores the previous PDF and reading position. Export waits for current rendered output. These are viewer limits, not an OS memory quota; see [PDF viewer limits](PDF_VIEWER_LIMITS.md).
- Native save/open/export, Save As asset copying, save conflict detection, source ZIP export, recovery, and close-time flush. Source, assets, manifest and history now use a durable save journal with rollback and crash recovery; metadata/history conflicts, post-commit warnings, same-profile single-instance handling and close-during-save behavior are tested.
- Startup keeps project controls inactive until recovery loads. Closing during compiler preparation preserves the previous recovery bytes; a startup error keeps them protected and offers Retry. The early-close regression reproduced the original overwrite before verifying the fix.
- Bounded ZIP project import, main-file selection, skipped-file review, new-folder extraction, independent project/history identities and ordinary folder opening. Header/path/link/CRC/actual-expansion validation happens before extraction; cancellation and failed-write cleanup are tested. See [ZIP import](ZIP_IMPORT.md).
- Durable import staging and per-file copy progress, real process-kill recovery and a review screen for finishing, opening, safely trashing or explicitly dismissing interrupted imports. Outside edits and replaced folders are preserved; open-project Trash refusal, acknowledgment failures, same-project reopening, close-during-resume and restart are tested. See [the recovery tutorial](tutorials/recover-an-import.md).
- External-file watching, source/asset review, reload with retained editor buffers, recovery before acknowledgment, and outside-source copies on approved save replacement. Builds/AI/exports wait for review, AI performs a final disk check, and accepting assets requires a fresh PDF build. Metadata/history conflicts remain explicit. See [external changes](EXTERNAL_CHANGES.md).
- Resizable file/writing/PDF panes with pointer/keyboard controls, constrained minimum sizes, reset and remembered proportions. Optional autosave reuses the save journal, preserves newer typing, defers during AI/dialogs/transitions and refuses background overwrites. See [workspace preferences](WORKSPACE_PREFERENCES.md).
- Explicit compiler migration with complete local backups, real before/after PDFs, a labeled saved-PDF fallback for missing runtimes, stale-input/backup checks and recovery before reporting Apply. See [compiler migration](COMPILER_MIGRATION.md).
- Unit, real-compiler, desktop workflow, and packaged smoke-test tooling.

See [the requirement-by-requirement release gap audit](RELEASE_GAP_AUDIT.md) for remaining Apple silicon release work and the next implementation order.

## Remaining before the Apple silicon Mac release

Windows, Linux, Intel Mac and cross-platform runtime equivalence are outside the user’s updated goal.

1. Apple silicon macOS-version and clean-machine acceptance; review the compiler sandbox against the supported macOS versions and signed-helper design.
2. Signed/notarized installers, signing-aware integrity manifests and authenticated updates.
3. Complete dependency/font license materials and an SBOM. Current notices are a development inventory.
4. Controlled template render comparisons, final packaged public-pack and online repair acceptance. Guided local fonts and the Settings pack workflow are implemented; the public table pack and signed catalog are available. The fault-injection workflow retains a temporary test publisher. Exact compiler retention, local offline repair and backed-up compiler migration pass their local/native workflows; broader Mac acceptance remains open.
5. Large-archive responsiveness and broader filesystem acceptance. Interrupted-import review and verified cleanup are implemented and covered by the earlier packaged qualification.
6. Complete accessibility, VoiceOver, native high-DPI and Mac keyboard acceptance.
7. Broader imported-template diagnostic and bibliography workflow coverage. Specific missing-package/font/engine guidance is implemented; see [build help](BUILD_HELP.md).
8. Hard compiler/OS memory and disk limits, application-wide resource measurements and deeper hostile-document testing. The viewer now has page/byte/geometry limits, virtualized pages, canvas budgets and bounded worker shutdown; see [viewer limits](PDF_VIEWER_LIMITS.md).
9. macOS save durability, supported network-filesystem and power-loss validation, including schema-migration interruption coverage. Guided interrupted-save resolution now has separate source-native evidence below.


Structured forms, source-to-preview navigation, and cloud sync remain deferred. AI writing is implemented under the newer [chat-first plan](CHAT_FIRST_IMPLEMENTATION.md); its validation and model/provider limits are recorded there and in the README.

## Boundaries

The resource bundle covers the included template corpus, not arbitrary LaTeX. A subprocess and disabled shell escape are not treated as a filesystem sandbox: compilation fails closed on unsupported platforms.

Source recovery stores one current open project; the UI asks before discarding edited work. Conversation and version stores are per project and persist independently. Saved project folders carry a `resume.folio` history archive. Projects/recovery are not encrypted by the application; API keys use protected storage. AI requests send source, recent conversation, and PDF images to the user's selected connection. There is no Folio cloud backend or required telemetry.

Local tests do not establish support for other systems or a clean-machine public installer. The full planned production scope is not claimed complete.

## Validation performed

- TypeScript checking and formatting checks passed.
- 109 unit/protocol tests pass (`test-results/pdf-viewer-unit-tests-final.log`), including five PDF admission/layout/canvas/scroll cases, ten compiler-migration cases and process-kill boundaries. The prior milestone's 11 real-compiler integration tests passed on the Apple silicon development host (`test-results/runtime-integration-tests.log`); runtime binaries/resources are unchanged. These cover provider payloads and errors, protected connection storage, agent retries and cancellation, immutable source/PDF history, recoverable file operations and deletion crashes, outside-file review/reload and save ordering, ZIP boundaries and project import, imported packages, an actual offline Biber bibliography, extensionless diagnostic paths, common article heading fonts, compiler identity persistence, retained copies and interrupted repair. Current packaged native coverage is listed below.
- All twelve PDFs (six layouts × A4/US Letter) were rendered and visually inspected; each sample is one page with checked text, links, embedded fonts and paper geometry. See `TEMPLATES.md`.
- Desktop tests passed for live editing, actual PDF text updates, diagnostics, retaining a previous preview, native saving/export, adding a source file, runtime settings, and close/reopen recovery.
- Appearance checks passed for Light/Dark persistence across app restarts, live System changes, native theme synchronization, editor instance/undo preservation, and unchanged white PDF pages. Dark workspace, settings, templates, and search were visually inspected.
- The standalone app passed a smoke test using its embedded runtime and a fresh application data directory.
- The Vite/Electron development workflow passed with its development script nonce and React Strict Mode enabled.
- Signing and public-release checks remain pending.
- Compact-layout regression checks cover relocated commands, all templates/snippets, menu keyboard focus, duplicate basenames, main-document selection, source-linked errors, theme/sidebar undo, and the minimum window size with larger editor text.
- Missing-runtime and empty-preview checks passed, including native Save without a compiler. The compact packaged app passed fresh-profile template and imported-package/font/Biber smoke tests. Visual evidence and accepted design differences are recorded in `design-qa.md`.
- The chat-first Apple silicon app and disk-image installer are built under `release/chat-first/`, including 516 locked LaTeX resources and the Biber runtime. Earlier compact builds remain in `release/compact-ui/`.
- The chat desktop suite exercises the real compiler, PDF renderer, encrypted credential storage, agent, version store and IPC with a synthetic local AI fixture. It verifies Settings-only connection selection, all four annotation tools, every-page review, apply/compare/undo/restore, cancellation/stale-result protection, retry, Save As, clean exports and restart recovery.
- The installed Codex subscription passed a real synthetic image test; inherited MCP tools were verified disabled before inference. Claude Code's installed command reports signed out; its request protocol is tested with a fixture. No live Claude subscription edit or real OpenAI/Anthropic API account inference is claimed.

- Final packaged chat workflow passed: `test-results/chat-AtkOEj/`, including bounded attachment scrolling and Send hit-testing at 1040 × 680. The final visual review passed; see root `design-qa.md`.

- Save reliability regression passed: real write-failure/forced-kill/rollback-cleanup tests and native desktop/chat Save As, damaged-history rejection and close-during-save checks. See `SAVE_RELIABILITY.md`. The updated development build is under `release/reliable-save/`; earlier builds remain available.

- Native ZIP import regression passed (`test-results/import-Mo37YO/`), including close-during-import recovery. Full native chat regression also passed after the stricter history reader (`test-results/chat-g0HLSN/`). Both use synthetic projects and isolated app data.

- Final packaged ZIP import and full chat suites passed (`test-results/import-NHWUVy/`, `test-results/chat-ytxzzW/`), with no renderer errors. That milestone's app/disk image remains in `release/project-import/`. Compact dark/light import dialogs and the preserved chat layout were visually inspected.

- The file-management milestone passed all three native suites: `test-results/files-YbAyZY/`, `test-results/chat-HpDWmb/`, and `test-results/import-hwx0nF/`. Undo, recoverable removals, restore collisions, outside edits, Save As, ZIP contents, restart, new-file creation and identical filenames in separate projects are covered. Long-filename, restore and chat captures were inspected. That build remains in `release/file-management/`.

- The external-change package passed `test-results/watch-TMBtBE/`, `test-results/chat-5QYOCQ/` and `test-results/files-b0YvJF/`. It verifies outside source/asset review, preserved editor and disk text, recovery before acknowledgment, missing-main protection, stale PDF export rejection, project switching, and completed AI drafts with delayed notifications. All recorded zero renderer errors. That milestone’s app/disk image: `release/external-changes/`; hashes and scope are in its README. The broader release plan remains active.
- The same package also passed the full ZIP import suite in `test-results/import-jJWpxu/`, with zero renderer errors. The test now waits for import completion before reading a new destination whose draft/PDF match the previous project; the application did not require a change for that test timing failure.

- The template package passed all twelve variants, native PDF exports, keyboard selection, origin persistence and restart in `test-results/templates-e3AJ8W/`. Its full chat and ZIP suites passed in `test-results/chat-LZmwWj/` and `test-results/import-aClX0f/`; all recorded zero renderer errors. All twelve sample PDFs and final dark/light picker captures were inspected. That milestone remains in `release/templates/`.

- The workspace-preferences milestone remains in `release/workspace-preferences/`. It adds resizable panes and optional autosave, including recovery of newer text after a failed in-flight write. Its PDF replacement test first reproduced a real destroyed-document race and then verified the corrected lifetime, matching annotation state and exact scroll preservation. Build/typecheck/format and all 85 unit tests passed. Final packaged test directories, hashes and scope are in the local-only `release/workspace-preferences/README.md`. The full production goal remains active.

- The runtime-management milestone remains in `release/runtime-management/`. Exact compiler selection, offline repair and startup recovery protection are implemented. An intermittent cold bibliography timeout was reproduced, then addressed by testing TeX/Biber during runtime preparation while preserving the 30-second document limit. Three fresh-profile source smoke runs and all five final packaged suites passed: `packaged-tWecz7`, `runtime-wh4NuI`, `chat-sOAeWp`, `import-q6Vxwh` and `workspace-HuVo7h`, with no renderer errors. Build/typecheck/format, 94 unit tests, 11 real-compiler integrations and offline corpus verification passed. All 37 packaged build outputs matched that source build; its disk image passed integrity verification. Historical hashes and evidence are in the local-only `release/runtime-management/README.md`.

- The compiler-migration milestone remains in `release/compiler-migration/`. Backed-up compiler comparison, recovery-safe Apply, renderer reload and close-during-Apply passed against that package. All five native suites passed: `migration-izrL7z`, `chat-4eTYBe`, `runtime-4gSWbe`, `workspace-BdYeCF` and `packaged-WjnC48`, with zero renderer errors. The local-only `release/compiler-migration/README.md` retains hashes, evidence, an earlier unexplained startup closure and two successful subsequent chat runs.

- Previous viewer app/disk image: `release/pdf-viewer/`. It adds PDF page/byte/geometry admission, visible-page rendering, bounded canvas pixels, owned-worker termination and current-render export checks. Native testing exposed and fixed a scrollbar-driven resize loop; the rejected candidate is retained in `release/pdf-viewer-pre-resize/`. All seven final native suites passed with zero renderer errors: `pdf-viewer-wqfcxa`, `pdf-lifecycle-ruhZsR`, `migration-usXUbo`, `chat-q8SUXG`, `runtime-QW2HCP`, `workspace-MBa6Ee` and `packaged-LzfGqt`. The viewer test creates ten workers across replacement/failure cases and finishes with only the current one; repeated small/full-window resizing and export recover correctly. Build/typecheck/format and 109 unit tests passed. The app is arm64, all 37 packaged outputs match and disk-image integrity passed. Exact hashes, measured bounds and limitations are retained in the local-only `release/pdf-viewer/README.md`. This completes the local viewer milestone, not the full Apple silicon production goal.

- Earlier import-recovery app/disk image: `release/import-recovery/`. Durable import staging, per-file progress and explicit review recover real process interruptions while preserving outside edits. The native suite also reproduced and verified a fix for same-project compiler readiness after a failed acknowledgment. Build/typecheck/format and 117 unit tests passed. All nine final packaged suites passed without renderer errors: `import-recovery-zpFmni`, `import-EZCPBZ`, `pdf-viewer-r7QTuS`, `pdf-lifecycle-C9WK1a`, `migration-R4GeGB`, `chat-4IqJFO`, `runtime-Jao42f`, `workspace-EERKcH` and `packaged-L6SucW`. The exact arm64 package matches all 37 build outputs and its runtime manifest; DMG integrity passed. Hashes, scope and retained failures are recorded in the local-only `release/import-recovery/README.md` artifact. Added documentation, tutorials/demos, skill, noncommercial licensing, performance profiling and `grawish/folio` publication remain tracked in [DELIVERY_SCOPE.md](DELIVERY_SCOPE.md).

## Compiler error help

The current source adds specific next steps for recognized missing files/packages/fonts, engine requirements, syntax errors and timeouts, while preserving raw output and source links. All 123 unit tests, the real missing-dependency/repair integration and the source-native suite passed without renderer errors. Curated synthetic screenshots extend the editor tutorial and demo gallery. See [implementation and verification details](BUILD_HELP.md). The earlier import-recovery package and its nine-suite results remain separate; the qualification set now includes a tenth diagnostic suite.

## Guided local fonts

The project menu now offers local OTF/TTF selection, a real PDF preview, and an explicit journaled save of source and font files. Preview/cancel, outside-edit rejection, reload, close during Apply, reopen, History checkpoints, Save As and ZIP asset preservation passed in the native app. All 130 unit tests and 14 compiler integrations passed, including all twelve template/paper variants with chosen fonts and a local TrueType fixture. See [local-font behavior, limits and evidence](LOCAL_FONTS.md). The qualification set now includes an eleventh local-font suite; older nine-suite hosted results remain evidence for their recorded earlier commit only.

## Reviewable support bundles

Settings → Privacy now offers an exact-file preview, section selection and local ZIP export. A fixed native-validated list of diagnostic counts/enums excludes resume/log/account/path/environment text. Five privacy/protocol tests and the whole 135-test unit suite passed. The source-native workflow verifies actual compiler-failure categorization, private-marker exclusion, exact ZIP bytes, cancelled/failed saves, reload and close during atomic export. See [support bundle scope and evidence](SUPPORT_BUNDLES.md). The expanded native qualification set includes a twelfth support suite; earlier package evidence does not qualify this addition.

## Guided interrupted-save recovery

The startup/project-menu review compares current, before-save and attempted files; validates fresh choices; preserves file versions, editor drafts and conversation copies; and resumes decisions across process interruption, native close or renderer reload. A durable profile marker prevents old unsaved source from replacing the chosen result. Source-native and targeted packaged UI coverage includes binary/history/deletion recovery and ZIP export, plus a failed-Apply retry. All 158 unit tests pass. See [recovery protocol and evidence](SAVE_RECOVERY_IMPLEMENTATION.md) and the [tutorial](tutorials/save-and-recover.md#recover-an-interrupted-save). The hosted qualification at 274ff95 passed all thirteen suites, including this recovery workflow. Exact artifact and script evidence is recorded in [the verification record](releases/mac-save-recovery-verification.json); earlier eleven-suite results retain their exact prior-commit scope.

## Managed pack Settings workflow in development

The native service now connects authenticated catalogs, reviewed imports, cancel/resume, staged installation, offline retry and cache clearing to Settings → LaTeX resources. A pack changes a project only after a real PDF preview and explicit Apply; failed old builds keep their error instead of an invented before PDF. Apply rechecks the target compiler. The full source suite passes 198 unit/protocol tests. The archive/installation core also passed all 15 real compiler integrations. The source-native pack workflow and existing included-compiler comparison regression pass with zero renderer errors. Three labeled screenshots and a plain-language guide show the development workflow.

The normal build now embeds the public publisher identity and catalog. The first table pack is published with pinned upstream source/material archives and separate notices. Six real offline table builds, real HTTPS cancellation/resume, hosted catalog renewal and normal-app public-catalog installation/preview/save/restart pass with zero renderer errors. The original fault-injection tests still use a temporary key and simulated transport. Final packaged acceptance of the public workflow remains required. See [implementation, evidence and next steps](MANAGED_PACKS.md).
