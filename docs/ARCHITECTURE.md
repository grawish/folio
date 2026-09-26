# How Folio works

Folio has three main parts. React draws the workspace. Electron handles native files and dialogs. A local compiler turns TeX into the PDF shown beside Chat.

## From request to PDF

1. Chat sends a typed request through `electron/preload.ts`.
2. `electron/core/agent.ts` captures the connection and model selection, routes locally between Fast and Capable roles, and collects source plus PDF images when needed. `ai-provider.ts` and `ai-process.ts` talk to the selected connection.
3. Exact-match patches apply atomically to a separate candidate. Every changed candidate builds locally. Narrow text edits use PDF metadata to compare pagination; other changes require every-page visual review.
4. Folio checks that the original project has not changed before applying the result. A stale result becomes a recoverable draft instead of replacing newer edits.
5. `src/components/PdfPreview.tsx` displays the successful PDF. Marks and notes are separate from PDF bytes, so exports stay clean.

AI setup and the active connection live in Settings. The chat composer exposes Auto, connection default, and manual model selection, remembered locally per connection. The renderer receives connection metadata, not saved key values. Native subscription adapters use installed provider commands. API adapters use the user's configured endpoint and key.

## Code map

| Area | Main files |
| --- | --- |
| Workspace and project lifecycle | `src/App.tsx`, `src/useWorkspace.ts` |
| Chat, notes and history | `src/components/ChatPanel.tsx`, `PdfAnnotations.tsx`, `VersionHistory.tsx` |
| Local compiler and isolation | `electron/core/compiler.ts`, `runtime.ts` |
| Managed compiler copies | `electron/core/runtime-manager.ts`, `compiler-migration.ts` |
| Signed resource packs and Settings | `electron/core/pack-service.ts`, `pack-catalog.ts`, `pack-download.ts`, `resource-pack.ts`, `src/components/ResourcePacks.tsx` |
| Projects, assets and recovery | `electron/core/project.ts`, `workspace.ts`, `save-transactions.ts` |
| Guided save recovery | `electron/core/save-recovery.ts`, `save-io.ts`, `project.ts`, `src/components/SaveRecovery.tsx` |
| Support snapshot and ZIP export | `src/shared/support.ts`, `electron/core/support-bundle.ts`, `src/components/SupportBundle.tsx` |
| Guided font selection and preview | `electron/core/local-fonts.ts`, `font-import.ts`, `src/components/FontSetup.tsx` |
| ZIP validation and recovery | `safe-zip.ts`, `project-import.ts`, `import-transactions.ts` |
| Outside-file review | `project-scan.ts`, `src/components/ExternalChanges.tsx` |
| PDF worker/render bounds | `src/usePdfDocument.ts`, `pdf-policy.ts`, `pdf-job.ts` |
| Typed bridge | `electron/preload.ts`, `src/shared/` |

## Latency and model routing

Model catalogs are cached for five minutes and retain configured choices when discovery fails. Auto stays within the selected connection; failures in authentication, quota or transport do not trigger cross-provider fallback. Fast and Capable role overrides live with connection settings. Credentials are captured in the main process for the run. Known supported reasoning options are passed explicitly; unknown options are omitted.

The Codex adapter reuses an isolated process with a 60-second idle timeout, creating fresh ephemeral threads and verifying tool isolation for each inference. Cancellation, connection changes and shutdown release the session. API requests do not create temporary workspaces. Claude command resolution and successful authentication are reused within a run.

PDF build provenance includes source, asset bytes and the exact compiler pin. Older snapshots without provenance remain readable but are rebuilt before reuse as a current baseline. Rendered images are cached by PDF bytes and annotations, bounded to four entries / 24 MiB and cleared on a project change. Run metadata records models, escalation, validation type and stage timings without credentials.

See [harness measurements](HARNESS_PERFORMANCE.md) for the synthetic benchmark and its limits.

## Stored data

A saved project uses ordinary TeX files and assets plus `resume.project.json` for identity/compiler metadata and `resume.folio` for conversations and history. Save As creates an independent project. Source ZIPs include project metadata and conversation/history; API credentials and build caches are excluded.

Folder and ZIP opening use the same bounded manifest reader. Numeric project formats 1 and 2 are supported; newer, malformed or unversioned manifests are rejected without silently downgrading them. A folder with no manifest remains supported. Opening format 1 is read-only; its next normal journaled save upgrades metadata to format 2 while preserving identity, compiler selection and history. Process-kill coverage is described in [save reliability](SAVE_RELIABILITY.md#project-format-upgrades).

App storage holds preferences, connection settings, protected keys, recovery data, and managed compiler generations. `FOLIO_USER_DATA` selects a separate data directory for development and tests. Never point destructive test fixtures at a real user's data.

Save transactions journal changes before modifying a project. Import transactions stage and hash archive contents before creating the destination copy. Recovery checks ownership and outside edits before finishing or removing files. Guided save recovery retains drafts and file versions, publishes durable choices, and blocks old recovery buffers until the selected files/history are reopened. See [guided recovery](SAVE_RECOVERY_IMPLEMENTATION.md). The detailed protocols and limitations are in [save reliability](SAVE_RELIABILITY.md) and [ZIP import](ZIP_IMPORT.md).

The runtime manifest pins all managed compiler bytes. A project keeps its compiler identity. Repair prepares and checks a replacement before activation. Comparison shows real PDFs and preserves a backup before a compiler change. See [runtime management](RUNTIME_MANAGEMENT.md) and [migration](COMPILER_MIGRATION.md).

Resource-pack operations have a native session lock and cancellation path. Only reviewed signed files or authenticated catalog entries authorize installation. The renderer sends operation IDs and pack IDs, never a trusted key, executable path or replacement manifest. Native close/reload waits for cancellation; complete signed archives are retained before staging. Selecting an installed pack reuses backed-up compiler comparison. A missing dependency may have no before PDF; its original error is retained instead. See [pack implementation and publication status](MANAGED_PACKS.md).

Local font selection keeps bytes in a native session until the user accepts a real PDF preview. Apply verifies the source and existing assets, then journals source/setup/font additions together. A post-commit History/recovery problem reports a warning without claiming rollback. See [local fonts](LOCAL_FONTS.md).

## Trust boundaries and limits

Treat imported files, TeX, provider output, PDFs, and external edits as untrusted input. Keep native operations behind validated IPC. Model output must not silently replace newer source. Compilation disables shell-escape workflows and network access through the current macOS isolation design.

PDF viewing is bounded to 100 pages and 25 MiB; AI visual review has a separate 20-page limit. Canvas/worker bounds are not operating-system resource quotas. Same-user filesystem races, power loss, network filesystems, signing-aware manifests, authenticated updates, and physical accessibility acceptance need further work. Keep these limits visible in [the audit](RELEASE_GAP_AUDIT.md).
