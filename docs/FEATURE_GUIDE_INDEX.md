# Feature documentation and demo coverage

This matrix tracks the user's requirement for tutorials and demos for every feature. Existing technical notes and automated tests are evidence, but do not substitute for a complete end-user tutorial or a public demo recording. Complete the pending entries against the final app before marking documentation delivery finished.

| Feature group | User tutorial | Technical notes / executable demonstration | Public demo |
| --- | --- | --- | --- |
| First launch, offline setup, template, paper size, save and PDF export | [First resume](tutorials/first-resume.md) | `TEMPLATES.md`; `test-templates.mjs`, `test-packaged.mjs` | Recording pending |
| Chat, sending requests, reading progress, stop, retry and factual questions | Pending | `CHAT_FIRST_IMPLEMENTATION.md`; `test-chat.mjs` | Pending |
| Codex subscription setup/sign-in/model selection | Pending; distinguish installed-account acceptance from fixtures | `CHAT_FIRST_IMPLEMENTATION.md`; provider protocol tests | Pending |
| Claude Code subscription setup/sign-in/model selection | Pending; live signed-in acceptance outstanding | Provider protocol tests | Pending |
| OpenAI/Anthropic API keys and connection checks | Pending; live-account acceptance outstanding | `AIConnections.tsx`; `test-chat.mjs`, provider API tests | Pending |
| Custom API formats, endpoints, optional keys, edit/remove/select connections | Pending | `AIConnections.tsx`; `test-chat.mjs` | Pending |
| PDF highlight, box, pen, note, selection, attachment and zoom alignment | Pending | `CHAT_FIRST_IMPLEMENTATION.md`; `test-chat.mjs` | Pending |
| History, compare, restore, undo and old-version notes | Pending | `CHAT_FIRST_IMPLEMENTATION.md`; `test-chat.mjs` | Pending |
| Code editing, search, undo/redo, tabs, snippets and main document | First resume covers basic edit/search; full tutorial pending | `test-desktop.mjs`, compact and file suites | Pending |
| File creation, rename, removal, restore and retained copies | Pending | `FILE_MANAGEMENT.md`; `test-files.mjs` | Pending |
| Open file/folder, recent projects, Save As and source export | First resume covers entry points; complete multi-file walkthrough pending | `ZIP_IMPORT.md`; `test-import.mjs`, `test-chat.mjs` | Pending |
| ZIP inspection, skipped entries, main-document choice and source/history round-trip | Pending | `ZIP_IMPORT.md`; `test-import.mjs` | Pending |
| Interrupted import review, resume, cleanup, outside edits and dismissal | [Recover an import](tutorials/recover-an-import.md) | `ZIP_IMPORT.md`; `test-import-recovery.mjs` | Recording pending |
| Manual save, autosave, close/restart recovery and dirty-document choices | First resume covers manual save; full recovery tutorial pending | `SAVE_RELIABILITY.md`, `WORKSPACE_PREFERENCES.md`; native suites | Pending |
| Outside-file changes, source reload, saved editor copies and conflicts | Pending | `EXTERNAL_CHANGES.md`; `test-watch.mjs` | Pending |
| Build diagnostics, source jumps, raw logs and last-good PDF | First resume introduces diagnostics; full tutorial pending | Compiler tests; desktop/compact suites | Pending |
| PDF text/links, page navigation, fit/zoom, size limits and failed-preview recovery | First resume covers navigation/export; limits tutorial pending | `PDF_VIEWER_LIMITS.md`; PDF viewer/lifecycle suites | Pending |
| Pane sizing, hidden sidebar, keyboard resizing, reset, themes and editor size | Pending | `WORKSPACE_PREFERENCES.md`; `test-workspace.mjs` | Pending |
| Compiler identity, offline repair, comparison, migration and backup inspection | Pending | `RUNTIME_MANAGEMENT.md`, `COMPILER_MIGRATION.md`; native runtime/migration suites | Pending |
| Privacy, protected keys, local storage, support and help/shortcuts | Pending | Settings implementation, existing README and provider tests | Pending |
| Additional managed packs, online repair, guided custom fonts, updater and support bundle | Await implementation and verification | Open requirements in `RELEASE_GAP_AUDIT.md` | Pending; do not demonstrate unimplemented behavior as real |

Script names in this table are under `scripts/`; technical notes are in this directory. Public demonstrations must use synthetic resume/account data. For AI, label any local protocol fixture visibly and document the separate steps needed to use a real account.
