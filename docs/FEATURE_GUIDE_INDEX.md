# Feature tutorials and screenshot demos

Every currently implemented feature group below has a plain-language walkthrough and a real-app screenshot demo. Use the linked native suites for reproducible behavior checks. The demos identify scripted AI and synthetic failure states; they do not claim live subscription/API acceptance or completion of planned features.

| Feature | Tutorial | Screenshot demo |
| --- | --- | --- |
| Your first resume | [Walkthrough](tutorials/first-resume.md) | [Screenshot](images/workspace.png) · Real app · synthetic project |
| Templates and paper size | [Walkthrough](tutorials/first-resume.md) | [Screenshot](images/templates.png) · Real app · synthetic project |
| Chat and agent progress | [Walkthrough](tutorials/chat-and-feedback.md) | [Screenshot](images/chat-workspace.png) · Real app · scripted local AI fixture |
| Codex subscription | [Walkthrough](tutorials/ai-connections.md) | [Screenshot](images/connection-codex.png) · Real form · no connected account |
| Claude Code subscription | [Walkthrough](tutorials/ai-connections.md) | [Screenshot](images/connection-claude-code.png) · Real form · no connected account |
| OpenAI API key | [Walkthrough](tutorials/ai-connections.md) | [Screenshot](images/connection-openai.png) · Real form · no connected account |
| Anthropic API key | [Walkthrough](tutorials/ai-connections.md) | [Screenshot](images/connection-anthropic.png) · Real form · no connected account |
| Custom AI endpoint | [Walkthrough](tutorials/ai-connections.md) | [Screenshot](images/connection-custom.png) · Real form · no connected account |
| Visual PDF feedback | [Walkthrough](tutorials/chat-and-feedback.md) | [Screenshot](images/annotations.png) · Real app · scripted local AI fixture |
| Compare, undo and restore | [Walkthrough](tutorials/chat-and-feedback.md) | [Screenshot](images/history.png) · Real app · scripted local AI fixture |
| Code and build errors | [Walkthrough](tutorials/editor-and-pdf.md) | [Screenshot](images/code.png) · Real app · synthetic project |
| Missing files, fonts and engine help | [Walkthrough](tutorials/editor-and-pdf.md#fix-a-missing-file-font-or-package) | [Screenshot](images/build-help-font.png) · Real compiler · synthetic missing font |
| Local font files | [Walkthrough](tutorials/editor-and-pdf.md#use-your-own-font-files) | [Screenshot](images/local-fonts.png) · Real app/compiler · synthetic project |
| Files and retained copies | [Walkthrough](tutorials/files-and-import.md) | [Screenshot](images/restore-file.png) · Real app · synthetic project |
| Open, import and export source | [Walkthrough](tutorials/files-and-import.md) | [Screenshot](images/import.png) · Real app · synthetic project |
| Recover an import | [Walkthrough](tutorials/recover-an-import.md) | [Screenshot](images/import-recovery.png) · Real app · controlled interruption fixture |
| Recover an interrupted save | [Walkthrough](tutorials/save-and-recover.md#recover-an-interrupted-save) | [Screenshot](images/save-recovery.png) · Real app · controlled interruption fixture |
| Save and autosave | [Walkthrough](tutorials/save-and-recover.md) | [Screenshot](images/general-light.png) · Real app · synthetic project |
| Review outside changes | [Walkthrough](tutorials/save-and-recover.md) | [Screenshot](images/external-changes.png) · Real app · synthetic project |
| Read and export the PDF | [Walkthrough](tutorials/editor-and-pdf.md) | [Screenshot](images/pdf-navigation.png) · Real app · synthetic project |
| Themes and workspace layout | [Walkthrough](tutorials/settings-and-compiler.md) | [Screenshot](images/general.png) · Real app · synthetic project |
| Editor and PDF preferences | [Walkthrough](tutorials/settings-and-compiler.md) | [Screenshot](images/editor-settings.png) · Real app · synthetic project |
| Offline compiler repair | [Walkthrough](tutorials/settings-and-compiler.md) | [Screenshot](images/compiler-repair.png) · Real app · isolated damaged-runtime fixture |
| Compare compiler versions | [Walkthrough](tutorials/settings-and-compiler.md) | [Screenshot](images/compiler-comparison.png) · Real app · synthetic compiler identity |
| Import a signed resource pack | [Walkthrough](tutorials/resource-packs.md) | [Screenshot](images/pack-import-review.png) · Real source app · published table pack |
| Install and retry a pack offline | [Walkthrough](tutorials/resource-packs.md) | [Screenshot](images/pack-installed-light.png) · Real source app/compiler · public HTTPS catalog |
| Preview a pack before using it | [Walkthrough](tutorials/resource-packs.md) | [Screenshot](images/pack-preview-light.png) · Real source app/compiler · controlled missing package |
| Reviewable support ZIP | [Walkthrough](tutorials/settings-and-compiler.md#make-a-support-bundle) | [Screenshot](images/support-bundle.png) · Real app · synthetic privacy fixture |
| Privacy and support | [Walkthrough](tutorials/settings-and-compiler.md) | [Screenshot](images/privacy.png) · Real app · synthetic project |

See [demo reproduction](demos/README.md) for commands and capture provenance. Pack workflows are demonstrated with the public catalog and published table resources. Final packaged acceptance remains open in [the release audit](RELEASE_GAP_AUDIT.md). Automatic updates have no working-feature demo yet. Wider OS, physical accessibility and live AI acceptance also remain open.
