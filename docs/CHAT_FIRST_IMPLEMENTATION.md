# Chat-first Folio implementation

This implements the agreed plan, using the selected current-layout preview in
`ui-previews/chat-first-screens/01-workspace.png` as the visual reference.

## Requirements and completion evidence

- [x] Default Chat tab beside the real PDF, existing file sidebar and optional Code tab.
- [x] Provider configuration, active-connection selection, API keys and model-role defaults only in Settings; the Chat composer exposes only Auto, connection-default and manual choices for that already active connection.
- [x] Codex subscription through the official app-server; Claude Code through its unmodified installed CLI.
- [x] OpenAI, Anthropic and custom compatible API connections with user-supplied keys, protected storage, connection tests and model selection.
- [x] Agent reads current TeX and rendered PDF, edits a working copy, compiles locally, visually checks every output page and retries at most three times.
- [x] Missing facts produce questions, not invented resume content; connection and build failures remain actionable.
- [x] Highlight, rectangle, pen and note annotations stay aligned at every zoom level and belong to an immutable PDF version.
- [x] Selected notes, cropped marked images, full-page context and corresponding source reach the agent.
- [x] Progress, cancellation, stale-result rejection and retention of the last successful PDF.
- [x] Persistent chats, drafts, annotations, stable project identity, version snapshots and matching PDFs.
- [x] Version comparison, restore and undo; newer manual changes are never silently overwritten.
- [x] Save, Save As, reopen, recovery and source/PDF export retain their existing behavior; exported PDFs are clean.
- [x] Existing layouts, themes, editor behavior, file actions, diagnostics, shortcuts and small-window usability remain available.
- [x] Meaningful unit, provider-protocol, agent-loop, real-compiler and desktop end-to-end verification.
- [x] Rendered desktop inspection and documented final limitations.

Checkboxes are completed only after implementation and corresponding verification.
The compiler and native isolation model remain unchanged. The pinned resource corpus now also includes standard article heading fonts (516 resources total).

## Approach

Use the existing Electron background process for connections, encrypted credentials,
local builds, version files and the agent loop. The renderer owns UI and PDF.js page
rendering. A narrow IPC bridge connects them. Resume edits are structured file changes,
validated with the existing project rules before compilation. Subscription tools keep
ownership of their sign-in credentials. Folio never extracts their tokens.

## Evidence map

| Requirement | Implementation | Verification |
| --- | --- | --- |
| Chat-first layout; Code remains available | `src/App.tsx`, `ChatPanel.tsx`, `chat.css` | Native chat test checks default tab, real PDF, Code editing, minimum window, and both themes. |
| Settings-only provider/active-connection setup; Chat model choice within that connection | `SettingsModal.tsx`, `AIConnections.tsx`, `connections.ts`, `ChatModelPicker.tsx` | Tests create/select a connection in Settings; Chat exposes Auto, connection default and discovered/manual models only for the active connection. Saving and selecting are separate actions. |
| Native subscriptions | `ai-process.ts`, `ai-provider.ts` | Codex/Claude protocol fixtures plus current real source-build synthetic-document workflows: Claude Code 2.1.282 (`sonnet` → `claude-sonnet-5`) and Codex 0.158.0 (`gpt-5.5`) each pass Settings image support, page-two note, exact edit, compilation, visual review, save/export and reopen. Each is one account/model; neither proves signed-release or broad subscription acceptance. |
| BYOK and custom formats | `connections.ts`, `ai-provider.ts` | Unit tests for all three wire formats, image payloads, keys, errors, cancellation, unsafe endpoints, connection revision races, and secret removal. Desktop fixture verifies actual protected key storage and authenticated localhost requests. |
| Read/edit/build/check loop | `agent.ts`, renderer `pdf-feedback.ts` | Agent tests force compile and visual failures, then success; reject unsafe edits, incomplete pages, mixed questions/edits, and cancellation. Native test sends two real PDF pages and checks both candidate pages before apply. |
| Annotations and source context | `PdfAnnotations.tsx`, `PdfPreview.tsx`, `NoteThumbnail.tsx` | Native pointer tests for highlight, box, pen, note, zoom alignment, selected crops, all-page context, lazy thumbnails, historical notes and clean PDF export. Unit test verifies old-version source and images. |
| Recovery and immutable versions | `workspace.ts`, `useWorkspace.ts` | Source/PDF hash verification and tamper rejection; serialized state updates; archive round-trip; stable reopen identity; independent Save As history; close/reopen during an AI request. |
| Compare/restore/undo and stale protection | `VersionHistory.tsx`, `App.tsx`, `project-scan.ts` | Native comparison, restore and Undo; manual edits or outside-file changes during inference prevent result application; checked draft stays in History. A final disk check is tested with watcher notifications suppressed. CodeMirror external changes do not create a false manual revision. |
| Existing workflow compatibility | Existing project/compiler services and Code tab | Original desktop and compact suites cover native save/export, templates, snippets, file selection, diagnostics, themes, search/undo and missing runtime. |

Paths in the table are relative to the corresponding `src/components`, `electron/core`, or repository directory. Executable tests are `tests/ai.test.ts`, `tests/provider-api.test.ts`, `tests/integration/compiler.test.ts`, and `scripts/test-{desktop,compact,compact-states,chat,packaged}.mjs`.

## Verification results

- TypeScript and production build passed. Formatting passed.
- 80 unit/protocol tests and 10 native compiler tests passed on this Apple silicon Mac, including the save journal, recoverable file operations, outside-file watching/review and bounded project/history ZIP import. Runtime inputs remain unchanged. Native cached-PDF export now also requires the current project revision after accepting changed assets.
- Original desktop, compact and missing-runtime regression suites passed after the Chat/Code and Settings route changes.
- Development chat end-to-end run passed: `test-results/chat-CiQPxP/`. It uses a local model protocol fixture with the real app, compiler, PDF.js, credential store and version store.
- Pinned runtime verification passed for Classic, Modern, Academic, basic article font/heading coverage, and imported resume/Biber coverage.
- The packaged app passed its standalone compiler/template/imported-Biber smoke test. The final full chat suite also passed against the packaged executable: `test-results/chat-AtkOEj/`. Visual QA passed in `../design-qa.md`; stable screen evidence is in `ui-previews/chat-first-implementation/`.
- A 29 September 2026 live Claude Code 2.1.282 run passes image support and the real annotated-edit/save/export/reopen workflow using a synthetic two-page document. The configured `sonnet` alias returned `claude-sonnet-5`; this proves one source-build account/model workflow. Exact source/PDF/history checks and screenshots are retained under `test-results/claude-native-ORYVHB/`. Live OpenAI/Anthropic API keys were not supplied or used.
- A 29 September 2026 live Codex CLI 0.158.0 run passes the same source-build workflow with pinned `gpt-5.5`; its sanitized result is [published](releases/codex-live-verification.json). Leaving the Model field blank inherited an unsupported local `gpt-6.1-sol` default and failed cleanly at provider level, so the check intentionally pins the supported catalog model. This proves one ChatGPT account/model only, not a signed installer or a broad model matrix.
- The external-change package passed the full chat suite in `test-results/chat-5QYOCQ/`, including outside edits during inference with native notifications both present and suppressed. The watcher, file-management and import suites also passed against this exact executable. Build hashes and scope are recorded in `release/external-changes/README.md`.

## Boundaries

This is implementation evidence for the chat-first amendment. It does not close the original cross-platform production release plan.

- AI use requires an image-capable connection. Factual accuracy is not guaranteed by the visual check: the prompt asks for missing facts and the response validator refuses simultaneous questions and edits, but users must still review model-written content.
- Agent review is limited to 20 pages, 30 selected notes, an 8 MB image-data budget, and three edit attempts. Oversized or invalid outputs fail without applying edits.
- Workspace state is bounded to 2,000 messages, 2,000 annotations, and 8 MB. History export is bounded to 200 MB expanded; import also limits compressed size, entry count and individual entries. These are explicit failures, not silent truncation of messages or notes.
- Versions preserve source and exact PDFs, not historical assets. Restore rebuilds with current project assets. Marks belong to the original PDF version and remain accessible through History and sent-message attachments.
- Save As forks identity and history and is unavailable during an active agent request. Source, assets, manifest and history now use a crash-recoverable save journal. Real process-kill and native close-during-save tests pass; target-platform/power-loss validation remains open. See `SAVE_RELIABILITY.md`.
- Compiler support is verified on this Apple silicon development host. Windows/Linux compilation fails closed until native restrictions are implemented; Intel, signing/notarization and clean-machine release validation remain pending.
- The 24 PNG previews are visual concepts, not claims that every illustrative account value, usage meter or general preference is implemented. The real UI displays verified connection states and working controls.
