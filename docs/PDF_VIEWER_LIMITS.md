# PDF preview limits and recovery

Folio keeps Chat as the main workspace, with the PDF alongside it and Code available in its own tab. The preview supports PDFs up to **100 pages and 25 MiB**. It draws the pages in view plus their immediate neighbours. Pages farther away keep their space in the document but release their canvases, text and links. Scrolling back recreates those contents, including notes attached to the saved PDF.

The viewer reads every admitted page's dimensions before replacing the document. This keeps navigation accurate for mixed portrait and landscape pages. Zoom and pane resizing preserve the position within the current page. Returning to a previous PDF after a replacement fails also restores its reading position. The preview reserves scrollbar space so fit-to-width does not repeatedly change the page width when a page nearly fits vertically.

## Bounds

| Work | Application limit |
| --- | --- |
| PDF input | Nonempty, at most 25 MiB |
| Page count | 1–100 |
| Page geometry | Finite positive dimensions; each effective dimension at scale 1 at most 14,400; aspect ratio at most 10:1 |
| One canvas | At most 4,194,304 pixels; neither side above 8,192 pixels |
| One preview's canvases | At most 16,777,216 pixels, including annotation overlays |
| Load and dimension inspection | 15 seconds |
| One visible page's text, raster and links | 15 seconds |
| AI page-image review | 45 seconds overall; existing 20-page and 8 MiB encoded-image limits still apply |
| One note thumbnail | 15 seconds overall; at most 800 × 1,200 pixels |
| Worker shutdown | Up to 200 ms for normal PDF.js cleanup, then terminate the owned Worker |

The pixel budget is shared between the visible pages and their annotation surfaces. At high zoom or device scale, Folio may use fewer raster pixels while retaining the correct CSS size, text positions and note coordinates. These preview choices do not change the PDF bytes exported by Folio.

The shared pixel limit represents at most **64 MiB of raw RGBA backing pixels per preview**. It is not a measurement or limit on total application memory. PDF.js also holds fonts, decoded images, operator lists, document data and worker structures; Chromium has its own graphics allocations. History and compiler comparison may display more than one preview while the main workspace remains mounted. Their budgets are per preview, not one application-wide quota. These timers also depend on the renderer event loop; they are not operating-system CPU limits.

## Failure and export behavior

A failed build keeps the previous PDF visible. A new PDF that is too large, malformed, unusually shaped, or too slow to open is also rejected with an explanation. If its first visible pages fail to render, Folio restores the previous successfully rendered document and position. The failed worker is terminated.

Once a replacement has successfully rendered its visible pages, its older document is released. If a later, previously unseen page fails, the viewer reports the failure and releases that document; it does not keep every earlier PDF worker alive indefinitely. A normal rebuild can restore the preview.

Export waits for the current PDF's visible pages and neighbours to finish rendering and for the current source revision to remain unchanged. A preview admission or rendering error blocks export. This prevents exporting a rejected replacement while the user is still looking at the previous PDF. Export does not pre-render every offscreen page. Native export retains its existing current-build, source-revision and outside-file checks, and exports the exact generated PDF without marks.

Annotations remain attached to their original saved PDF. They are unavailable while a different document is loading or rejected, so marks cannot be accidentally placed on the older visible document as though it were the new one.

## Worker ownership

`src/pdf-job.ts` owns each real module Worker and waits for its ready message before handing its port to PDF.js. It makes a private copy of the input bytes and disables worker resource fetching, WebAssembly and system-font lookup. Folio does not use a main-thread parser fallback.

Ordinary PDF.js task destruction can wait for worker setup or a termination acknowledgment. The native failure test reproduced a case where that wait never finished. Folio now gives normal cleanup a bounded grace period and then terminates the actual Worker independently. The same helper serves the preview, AI page images and note thumbnails.

## Verification

`npm run test:pdf-viewer` builds the app and runs the native regression in a synthetic profile. It compiles real 35-, 100- and 101-page TeX documents, checks text and links, moves repeatedly between distant pages, and verifies that an evicted canvas is disconnected with its backing dimensions reset to zero. A note on page 35 must survive scrolling away and back.

The test measures canvas allocation at ordinary scale and at a simulated device ratio of 4 with 180% zoom. Controlled IPC fixtures provide oversized, malformed and extreme-geometry PDFs. Small valid mixed-size PDFs exercise exact page geometry. Held worker messages simulate load and render stalls; the test asserts actual Worker termination, export refusal, preservation of the earlier PDF and recovery after rebuilding. Worker tracking checks that repeated replacements and failures leave only the current preview worker alive. Repeated minimum/full-window resizing must settle to a stable canvas width and ready status, followed by successful export.

`npm run test:pdf-lifecycle` separately delays replacement while changing zoom and pane size, checks the previous PDF remains usable, and checks scroll retention and superseded-load cleanup. The full chat suite covers annotation crops, page-image review, history comparison and clean exports through the shared worker helper.

The final packaged viewer test passed in `test-results/pdf-viewer-wqfcxa/` with no renderer errors. The 100-page view contained three page canvases and three overlays, using 2,712,690 pixels. The simulated high-DPI/zoom view used 16,764,228 pixels, within the 16,777,216-pixel budget. Ten workers were created across the replacement/failure sequence; only the current preview worker remained afterward. The repeated small/full-window stability and final export checks passed. These are canvas and worker-lifecycle measurements, not process-memory or physical-display acceptance results. Full packaged qualification and exact hashes are recorded in the release README.

Source evidence also includes `test-results/pdf-viewer-SAzmxS/`, `pdf-lifecycle-8sZvsw/` and full chat `chat-jxYDv2/`. The reduced resize reproduction passed at all five window sizes after the gutter fix in `pdf-resize-pPZf3n/`.

Earlier failed runs are retained. They exposed scroll anchoring jumps, an evicted text-layer race, incomplete worker termination and a worker-ready handshake race. Separate harness failures involved counting annotation canvases, attempting to replace a frozen preload method, and waiting less than the application's deadline; those were test corrections. The first packaged attempt (`test-results/pdf-viewer-knwHdH/`) also exposed a test editing mistake: filling CodeMirror's virtualized contenteditable replaced only a rendered range of the long source. The saved synthetic recovery file contains the old source through page 86 followed by the next test's preamble. The harness now uses the editor's whole-document Select All command before typing. The app binary was unchanged for that correction. No renderer error is suppressed in the passed native results.

The next packaged run (`test-results/pdf-viewer-RMUd9y/`) found a real resize loop. A reduced native reproduction (`test-results/pdf-resize-7mHuyB/`) remained busy after 20 seconds. Temporary lifecycle diagnostics (`pdf-resize-aqDe8m/`) showed the page repeatedly switching between 397 and 408 pixels wide as scrollbar visibility changed. Reserving its gutter fixes the width feedback loop. The diagnostic logging was removed from the application; the final regression checks sustained readiness as well as text visibility.

## Remaining release work

Hard compiler/OS memory and disk quotas, deeper hostile-PDF testing, application-wide resource measurements, physical high-DPI and VoiceOver acceptance, and reference-device performance remain open. The existing AI review limit is separate from the 100-page local viewer limit. See [the release audit](RELEASE_GAP_AUDIT.md); this improvement does not complete the public Apple silicon release.
