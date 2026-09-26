---
name: folio-resume
description: Help people use and troubleshoot Folio, the chat-first LaTeX resume app for Apple silicon Macs. Use for its AI connections, PDF feedback, editing, imports, saves, history, compiler repair, and source-development workflow.
---

# Folio

Use the bundled documentation to help with the user's current Folio workflow. Explain steps in plain language and name the visible controls. Identify the installed/source version when behavior differs; these references describe the 0.1 development preview.

## Route to the relevant guide

Read only what the task needs:

- First launch, templates, paper size, saving and PDF export: [first-resume](references/first-resume.md).
- Codex, Claude Code, BYOK, custom endpoints, selecting/editing/removing a connection: [ai-connections](references/ai-connections.md).
- Chat, PDF marks, attachments, stop/retry, compare, undo and restore: [chat-and-feedback](references/chat-and-feedback.md).
- Source files, main document, ZIP import, Save As and source export: [files-and-import](references/files-and-import.md).
- Autosave, recovery, outside-file changes and conflicts: [save-and-recover](references/save-and-recover.md).
- Interrupted ZIP copies and keeping outside edits: [recover-an-import](references/recover-an-import.md).
- TeX edits, local font files, search, diagnostics, page navigation and viewer limits: [editor-and-pdf](references/editor-and-pdf.md).
- Appearance, panes, privacy, reviewable support ZIPs, help, compiler repair/comparison: [settings-and-compiler](references/settings-and-compiler.md).
- Implementation questions: [architecture](references/ARCHITECTURE.md), then the relevant source files in a local checkout.
- Release/support claims: [release audit](references/RELEASE_GAP_AUDIT.md). Do not turn an open requirement into an available feature.

## Product facts that change the answer

Chat is the main workspace; Code is secondary. AI setup, model configuration and active-provider selection happen only in Settings. Folio uses installed Codex/Claude Code commands or user-configured APIs; a subscription is not an API key. Provider account eligibility and image support require checking separately. Never request that users paste keys into chat or documents.

The local compiler can work without AI. Sending a chat shares relevant source, conversation and PDF images with the selected provider. Source ZIPs contain conversations/history; clean PDF exports do not contain annotations. Explain this difference when helping someone share a project.

Review the actual PDF after changing TeX. A last-good PDF can remain visible while current source fails. Use the current build/render state before recommending export. Viewer bounds are 100 pages/25 MiB; AI review has a separate 20-page bound. A model's visual review does not verify resume facts.

Protect the current draft and outside edits during recovery. A stopped ZIP import can be finished, reopened, moved to Trash when verified, or dismissed while keeping files. Do not bypass a blocked ownership/outside-edit check. Prefer the documented recovery UI over manually deleting recovery data. For interrupted saves, use the project menu or failed-startup review to compare current/before/attempted files. Review every choice, including deletions, and apply with backups. A stale review needs Refresh and new choices. Keep the retained source/conversation copies; ordinary recovery must not erase a pending decision. Unreadable records or damaged retained storage can still require manual repair.

## Helping with changes or diagnosis

For a TeX edit, understand the requested outcome, keep claims supplied by the user, make a narrow change, build, and inspect all affected pages. Preserve the project structure and relative assets. For a failed build, use source-linked diagnostics and the raw log; avoid guessing that an old visible PDF proves success.

For development, use Node 24 and an Apple silicon Mac. `npm ci`, `npm run setup`, `npm run dev` are the initial path. Native tests need an isolated `FOLIO_USER_DATA` directory and should run sequentially. Existing tests and screenshots use synthetic data; do not substitute a real resume or account in a fixture. Choose verification based on the changed behavior.

This skill does not install Folio, configure an account, grant publishing permission, or provide an application-control tool. Use available tools only within the user's request. If direct app control is unavailable, provide the exact documented steps instead of claiming an action happened.

Folio's original work is PolyForm Noncommercial source-available software. Third-party components retain their own licenses. The current public source preview is distinct from a signed/notarized production app release.
