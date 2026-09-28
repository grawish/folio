# Ordinary typing and natural collection

The strengthened follow-up now passes both 120-cycle protocols, with an independent check of every source, PDF, history version and raw counter. Its results are below. The earlier anomalous run remains preserved separately.

The initial two 120-cycle sessions preserve useful data, but **the pair fails the intended workspace-state protocol**. One Code idle endpoint recorded zero attached editor views. Its selected tab was not captured, so the cause is unknown. Keep the full result, including that cycle, separate from a clean continuous-Code acceptance run.

## What was exercised

On an Apple M4 Pro with 48 GiB RAM and macOS 27, each fresh profile opens a one-page synthetic document. Each cycle changes four visible revision digits through keyboard events, types one short comment, builds, exports the PDF and idles for 2.5 seconds. One session requests Code throughout; the other switches to Chat between edits. Code ran first, then Chat. These are sequential observations, not randomized timing pairs.

The measured app is `d042c50`, with ASAR SHA-256 `52a2d038ad90da72682ccc05ba4aab688ce471a1609011312f48f307d4eefd4f`. It includes Git and PDF change highlighting but predates the later Git tabpanel accessibility fix. The initial harness is `78507cb`. Neither session requests garbage collection, heap snapshots or allocation sampling. Startup/compiler preparation and final undo/redo checks are outside sampling. All fixture content is synthetic.

## Initial observations and limits

| Observation | Code requested | Chat between edits |
| --- | ---: | ---: |
| Edit/build/export cycles | 120 | 120 |
| Raw process-tree snapshots checked | 3,519 | 3,553 |
| Observed interval | 623.44 s | 636.14 s |
| Summed process RSS peak | 971.1 MiB | 959.7 MiB |
| Summed process footprint peak | 789.4 MiB | 772.8 MiB |
| First ten idle endpoints: median RSS | 632.5 MiB | 585.8 MiB |
| Last ten idle endpoints: median RSS | 769.1 MiB | 773.6 MiB |
| First ten idle endpoints: median footprint | 293.5 MiB | 244.7 MiB |
| Last ten idle endpoints: median footprint | 349.1 MiB | 374.1 MiB |
| Final renderer used JS heap | 14.13 MiB | 20.03 MiB |
| Final renderer DOM nodes | 1,454 | 878 |
| Largest idle CPU observation, percent of one core | 9.95% | 2.64% |
| Intended idle view state | **Failed at cycle 62** | All 120 endpoints agree |

RSS and footprint peaks occur independently; summed process values are not unique physical memory. The short native sampling interval can miss short-lived processes. The records retain observer cost, each native process counter, phase boundaries, every endpoint and every ten-cycle block. The node counter includes more than connected editor nodes and is not a retained-object ownership analysis.

An independent reader recomputes all 7,072 native snapshots using the recorded Mach timebase. It verifies 240 actual exported PDFs, 242 actual saved history versions and both final recovery files. All 120 source/PDF-text/page-geometry pairs agree. The harness observed final undo/redo; it did not record physical input-method behavior. The reader rejects changed CPU totals, RSS totals, source sequences, export hashes and view counts in five isolated controls.

The first strict read fails at `cycle-62-idle-end` in the Code run. The old harness checked the view before idle, then recorded the endpoint count without asserting it. The reader's explicit `--retain-protocol-deviations` mode keeps the data checks and emits `passed: false`; it does not turn the experiment into a passing run. The endpoint before and after the anomaly each has one view. No selected-tab record or screenshot at that instant exists, so neither a user interaction nor an application fault has been established.

These measurements do not establish a stable memory plateau, a causal memory benefit of Chat, a speed improvement or supported-device resource acceptance. Both runs' idle RSS and footprint medians increase. Earlier large-document CPU threshold failures remain open. A successful short ordinary-typing fixture would not replace the large-history, long-document, physical IME, accessibility or production-release requirements.

## Verified follow-up

Short Code/Chat controls passed before repeating the long sessions at harness source `1f6d967`. The application bytes and synthetic workload stayed the same. At every recorded endpoint, one atomic renderer read confirms the selected workspace tab, visible panel and attached editor count. Code has one editor throughout; Chat has zero between edits. The original anomaly did not recur, but the first run does not contain enough evidence to establish its cause.

| Observation | Code throughout | Chat between edits |
| --- | ---: | ---: |
| Cycles / checked native snapshots | 120 / 3,597 | 120 / 3,599 |
| Observed interval | 640.36 s | 644.99 s |
| Summed process RSS peak | 942.8 MiB | 940.2 MiB |
| Summed process footprint peak | 766.6 MiB | 767.7 MiB |
| First ten idle endpoints: median RSS | 629.1 MiB | 588.1 MiB |
| Last ten idle endpoints: median RSS | 762.9 MiB | 767.2 MiB |
| First ten idle endpoints: median footprint | 293.6 MiB | 244.1 MiB |
| Last ten idle endpoints: median footprint | 346.5 MiB | 366.4 MiB |
| Final renderer used JS heap | 16.23 MiB | 20.30 MiB |
| Final renderer DOM nodes | 2,203 | 878 |
| Largest idle CPU observation, percent of one core | 4.76% | 2.04% |
| View-state deviations | 0 | 0 |

The reader verifies 240 actual exports, 242 saved history versions, both final recovery files and all 7,196 native process snapshots. Every source and PDF-text/page-geometry pair agrees. These results support the recorded ordinary-typing workflow and hidden-view behavior. They do not show a stable memory plateau or a causal whole-app memory reduction: late idle RSS and footprint are higher in both modes, and their final RSS is similar. Lower DOM counts in Chat alone do not prove lower total memory use.

The main process accounts for about 140 observed CPU-seconds in each run, and the renderer for 48.0 seconds in Code and 43.7 seconds in Chat. The native sampler records only 1.5–1.6 Tectonic CPU-seconds; a short compiler process can start and finish between samples, so these are incomplete process observations, not a total-cost percentage. The earlier function-level profiler, rather than these process totals, identifies runtime verification as the main-isolate bottleneck. The observer itself records 6.93 and 7.55 CPU-seconds separately.

The separate profiles run in order, not as randomized timing pairs. Startup, compiler preparation and final undo/redo are outside the sampled intervals. The existing large-document CPU failures and wider resource acceptance remain open. No application code changed between the initial and follow-up typing experiments.

See [the complete follow-up verification](releases/editor-ordinary-session-verification.json) and [raw traces, exports and saved history](performance/editor-ordinary-session-traces.tar.gz). Extract this archive into an empty directory and run `python scripts/verify-editor-session.py /path/to/code /path/to/chat`; this pair produces both `dataVerificationPassed: true` and `passed: true`.

## Follow-up observer

The harness now captures the selected workspace tab, visible panel and editor count together in one renderer evaluation. It checks all three at every idle endpoint after saving the observation. A mismatch stops the run and retains the partial report and a failure screenshot. Validate that observer on short Code/Chat controls before another long session. Preserve the initial run and any new failure; do not silently drop or relabel an anomalous cycle.

Run only after other local native suites and builds finish. The executable must be an Apple silicon package; keep its bytes unchanged throughout the pair:

```sh
FOLIO_PYTHON=/path/to/python-with-pypdf node scripts/profile-editor-session.mjs /path/to/Folio.app/Contents/MacOS/Folio code 2
FOLIO_PYTHON=/path/to/python-with-pypdf node scripts/profile-editor-session.mjs /path/to/Folio.app/Contents/MacOS/Folio chat 2
python scripts/verify-editor-session.py /path/to/code-control /path/to/chat-control
# After the controls pass, repeat with 120 cycles per mode.
```

The reader is deliberately bound to the measured app/runtime identity. Update that declared scope and independently verify a replacement app before using it for a different package. For historical evidence, extract the [initial trace archive](performance/editor-ordinary-session-initial-traces.tar.gz) into an empty directory and run:

```sh
python scripts/verify-editor-session.py /path/to/extracted/code /path/to/extracted/chat --retain-protocol-deviations
```

The current repository must contain the original harness commits; `pypdf` is required. The command checks data and returns a JSON record with `dataVerificationPassed: true` and `passed: false` for this preserved experiment. See [the complete verification and file digests](releases/editor-ordinary-session-initial-verification.json) and [the broader improvement plan](PERFORMANCE_IMPROVEMENT_PLAN.md).
