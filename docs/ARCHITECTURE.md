# How Folio works

Folio has three main parts. React draws the workspace. Electron handles native files and dialogs. A local compiler turns TeX into the PDF shown beside Chat.

## From request to PDF

1. Chat sends a typed request through `electron/preload.ts`.
2. `electron/core/agent.ts` collects the current source and relevant PDF images. `ai-provider.ts` and `ai-process.ts` talk to the selected connection.
3. The agent edits a separate working copy, builds it, and asks the model to inspect the output pages.
4. Folio checks that the original project has not changed before applying the result. A stale result becomes a recoverable draft instead of replacing newer edits.
5. `src/components/PdfPreview.tsx` displays the successful PDF. Marks and notes are separate from PDF bytes, so exports stay clean.

AI setup and the active connection live only in Settings. The renderer receives connection metadata, not saved key values. Native subscription adapters use installed provider commands. API adapters use the user's configured endpoint and key.

## Code map

| Area | Main files |
| --- | --- |
| Workspace and project lifecycle | `src/App.tsx`, `src/useWorkspace.ts` |
| Chat, notes and history | `src/components/ChatPanel.tsx`, `PdfAnnotations.tsx`, `VersionHistory.tsx` |
| Local compiler and isolation | `electron/core/compiler.ts`, `runtime.ts` |
| Managed compiler copies | `electron/core/runtime-manager.ts`, `compiler-migration.ts` |
| Projects, assets and recovery | `electron/core/project.ts`, `workspace.ts`, `save-transactions.ts` |
| ZIP validation and recovery | `safe-zip.ts`, `project-import.ts`, `import-transactions.ts` |
| Outside-file review | `project-scan.ts`, `src/components/ExternalChanges.tsx` |
| PDF worker/render bounds | `src/usePdfDocument.ts`, `pdf-policy.ts`, `pdf-job.ts` |
| Typed bridge | `electron/preload.ts`, `src/shared/` |

## Stored data

A saved project uses ordinary TeX files and assets plus `resume.project.json` for identity/compiler metadata and `resume.folio` for conversations and history. Save As creates an independent project. Source ZIPs include project metadata and conversation/history; API credentials and build caches are excluded.

App storage holds preferences, connection settings, protected keys, recovery data, and managed compiler generations. `FOLIO_USER_DATA` selects a separate data directory for development and tests. Never point destructive test fixtures at a real user's data.

Save transactions journal changes before modifying a project. Import transactions stage and hash archive contents before creating the destination copy. Recovery checks ownership and outside edits before finishing or removing files. The detailed protocols and limitations are in [save reliability](SAVE_RELIABILITY.md) and [ZIP import](ZIP_IMPORT.md).

The runtime manifest pins all managed compiler bytes. A project keeps its compiler identity. Repair prepares and checks a replacement before activation. Comparison shows real PDFs and preserves a backup before a compiler change. See [runtime management](RUNTIME_MANAGEMENT.md) and [migration](COMPILER_MIGRATION.md).

## Trust boundaries and limits

Treat imported files, TeX, provider output, PDFs, and external edits as untrusted input. Keep native operations behind validated IPC. Model output must not silently replace newer source. Compilation disables shell-escape workflows and network access through the current macOS isolation design.

PDF viewing is bounded to 100 pages and 25 MiB; AI visual review has a separate 20-page limit. Canvas/worker bounds are not operating-system resource quotas. Same-user filesystem races, power loss, network filesystems, signing-aware manifests, authenticated updates, and physical accessibility acceptance need further work. Keep these limits visible in [the audit](RELEASE_GAP_AUDIT.md).
