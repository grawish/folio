# Help with compiler errors

Build output explains recognized missing package/class, project file, font and engine requirements. It also gives a first step for common syntax errors and compiler timeouts. The exact compiler messages, source links and Raw log remain available. Successful, cancelled and runtime-unavailable results never get document-repair advice.

`src/shared/build-help.ts` derives advice without changing `BuildResult` or the diagnostics parser. Package, file and font patterns use error messages only; warnings cannot trigger repair advice. The `iftex` engine requirement is read from its explicit raw-output banner because Tectonic does not attach it to an `error:` line. A generic XeTeX crash or a source excerpt containing an engine name does not establish an incompatible-engine diagnosis. Unknown messages remain unchanged. Display names are bounded; React renders their text without HTML interpretation.

`src/App.tsx` renders the explanation in the existing scrollable Diagnostics panel. It does not change project contents, select an AI connection, download resources, or change compiler settings. Runtime damage retains its existing separate repair flow. The last good PDF and stale indicator retain their existing behavior. See the [plain-language walkthrough](tutorials/editor-and-pdf.md#fix-a-missing-file-font-or-package).

## Verification

- Unit tests cover real message forms, source-diagnostic preservation, engine-banner detection, misleading source excerpts, warning-only output, unknown failures, runtime failures, syntax/time-limit messages and long filenames.
- The real compiler integration case creates package, class, source-file, font, LuaTeX and pdfTeX failures, checks each diagnosis, and successfully rebuilds after adding a local `.sty`, `.cls` or `.tex` file, choosing the bundled Latin Modern font, or adapting the simple engine-check fixture. All builds use the existing offline OS sandbox.
- `scripts/test-diagnostics.mjs` drives the actual Electron app. It checks the retained PDF/stale label, original raw output and source-line navigation; exercises scrolling at 1040 × 680 in dark/light themes; and checks that the suggested font change succeeds and clears the advice.
- Native qualification includes this additional suite. Results from older commits with nine suites do not establish qualification of the newer application or its tenth suite.

On the development Mac, 123 unit tests, the targeted real compiler integration and the source-native diagnostic suite passed. Native evidence is `test-results/diagnostics-SDyhPC/`; it recorded no renderer errors. Font, engine and compact light screenshots were visually inspected. Curated synthetic captures and hashes are in `docs/images/qualified-captures.json`. An earlier native test incorrectly assumed the package command's line number; its retained failure in `diagnostics-h0C9yV/` led to checking navigation against TeX's actual reported line.

The same diagnostic suite passed against `release/build-help/mac-arm64/Folio.app` with no renderer errors (`diagnostics-ZnNRMO/`). Its app.asar SHA-256 is `12ae3e195076843953941585ea0e5ac1e870c58206765d58e429c3b2b97adf4d`. Packaged build outputs and the runtime manifest were compared with the source build; local evidence is `release/build-help/feature-verification.json`. This is targeted feature verification of an unsigned app, not a full ten-suite qualification or an installer release.

## Limits

This recognizes a conservative set of compiler messages; it is not a full TeX compatibility analyzer. LuaTeX/pdfTeX requirements are recognized from the `iftex` banner. Other packages can report different engine/font errors and still require reading Raw log. New patterns need actual failure fixtures before being advertised as supported. Changing a font can change line breaks and page count. Guided font import, managed expansion packs and broader platform acceptance remain in the release audit.
