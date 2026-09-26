# Local fonts

**More project actions → Add local fonts…** lets a user choose local OTF or TTF files, build a real PDF preview, and save the source and font files together. A regular file is required. Bold, italic and bold italic are optional; an omitted style uses the regular file, without synthetic bold or slant. This changes the document's main and sans-serif defaults together. It does not offer separate heading, monospace, math or icon font selection. The [plain-language tutorial](tutorials/editor-and-pdf.md#use-your-own-font-files) shows the workflow.

Save the project in a folder first. Selections remain in native-process memory until **Use fonts & save**. The app waits for the preview to load and render before applying. Cancel, Stop and close, and renderer reload discard the pending selection. Other project/agent/compiler operations cannot replace the project during an active font session.

## Source and storage

`electron/core/local-fonts.ts` reads selected regular files without following leaf symlinks or blocking on pipes. It enforces a 20 MiB total selection limit and checks the sfnt signature, table directory, unique printable table names, required table entries and bounded offsets. These are basic container checks, not font sanitization or a guarantee of valid glyph data. The [OpenType specification](https://learn.microsoft.com/en-us/typography/opentype/spec/otff) defines the container. Full loading happens only in the existing offline OS-sandboxed compiler.

Original filenames are display-only. Each successful setup creates `fonts/folio-<uuid>/regular.otf` (or `.ttf`) plus selected style files and `font-setup.tex`. The main source gets a relative `\input` before its plain top-level `\begin{document}`. The generated setup loads `fontspec`, defines `\setmainfont` and `\setsansfont`, and preserves the template's default-family choice. It temporarily selects the Roman default while loading `fontspec`, so a template that previously used a T1 sans default does not request an unavailable TU sans font before the chosen local font is defined.

`electron/core/font-import.ts` binds the preview to the exact source snapshot and existing asset hashes. Apply checks disk state again. Changed source or outside files require a new preview/review. `ProjectStore.saveWithAssets` rejects existing asset names, inconsistent folder spelling/case and the combined project limit of 200 source/asset files or 25 MiB. The normal save journal commits source, setup and binary font additions together, with rollback/recovery after failure or process termination. Queued writes copy their input buffers. A native close waits for Apply to finish.

A successful apply checkpoints the matching PDF in History. If that later archive or recovery update fails, the UI reports that fonts were saved and explains the remaining problem. It must not claim the already-committed font files were rolled back. Save As and source ZIP exports preserve the font bytes. Earlier font files remain in the project so older source versions can still refer to them. History does not snapshot arbitrary later edits to those binary assets. The project limits still apply; font imports do not prune historical assets automatically.

## Limits and troubleshooting

- Standalone `.otf` and `.ttf` files only. Collections (`.ttc`), web fonts (`.woff`/`.woff2`) and font-family discovery through macOS are not supported by this picker. Files are private project resources; Folio does not install them system-wide.
- This adds default font commands near the end of the preamble. It does not rewrite existing `fontspec` commands, custom font families, class internals or font commands inside the document. An earlier command requesting a missing font can fail before the new setup is reached; remove or correct that command in Code, then build a new preview. Custom template choices may override defaults. Inspect every page.
- The insertion scanner handles ordinary comments, escaped symbols and nested brace groups. It is not a full TeX interpreter; documents with unusual preamble structure may require manual editing. A real successful compile and loaded PDF are required before Apply.
- Missing font glyphs, different metrics or an omitted style can change appearance, wrapping and page count. A successful compile does not establish language coverage or visual equivalence. Choose appropriate style files and review the PDF.
- Source ZIPs include the chosen font files. Use fonts whose terms permit your intended use and sharing. The test's bundled Roboto fixtures are synthetic selections; the local macOS TrueType integration fixture is never copied to the repository or distributed.

## Verification

Run `npm test`, `npm run test:integration`, and `npm run test:fonts` on an Apple silicon Mac after runtime setup. Native suites run sequentially. `scripts/test-fonts.mjs /absolute/path/to/Folio.app/Contents/MacOS/Folio` tests a packaged app without rebuilding it.

The seven focused unit tests cover malformed containers, bounded reads, symlinks/pipes, source insertion, asset/source saves and Save As, outside edits, size/name conflicts, rollback, actual child-process termination before/after commit, stale previews and cancellation. The whole unit suite passed 130 tests (`test-results/local-fonts-all-unit.log`). The first two focused attempts retained failing test evidence; the corrected case-conflict test uses an independent project because a rolled-back write can leave empty directories on a case-insensitive Mac volume.

Real offline compiler tests passed all six templates at both paper sizes with all four Roboto styles, and a separately selected local TrueType file (`test-results/local-fonts-integration.log`). The test rejects missing-glyph/font-shape diagnostics in the twelve-template corpus. The native source run `test-results/fonts-xHqT29/` passed with no renderer errors: save-first, invalid selection, all four native selection slots, preview without writes, compact dark/light controls, cancel, cancelled picker, outside edit rejection, reload cleanup, close during a held journal write, reopen, History checkpoint, Save As and ZIP byte equality. Screenshots were visually inspected; curated copies/hashes are in `docs/images/qualified-captures.json`.

The full real compiler integration suite also passed all 14 tests (`test-results/local-fonts-all-integration.log`), including imported/Biber and managed repair behavior.

The same native suite passed against `release/local-fonts/mac-arm64/Folio.app` with no renderer errors (`test-results/fonts-ZkfxDA/`). Its app.asar SHA-256 is `dfe0a98416bbce0ec1c52b18e33e6f1b302dbbd8751d9220ac531b4bc505e386`. All 37 packaged build files and the runtime manifest matched. The exact local record is `release/local-fonts/feature-verification.json`. This verifies an unsigned app for this feature; no DMG or full eleven-suite qualification is claimed.

These are feature checks on the development Mac. The expanded eleven-suite native release set, broader macOS/clean-machine acceptance, final installer verification, signing/notarization and complete binary redistribution materials remain separate release requirements. Earlier nine-suite hosted evidence does not qualify this later code.
