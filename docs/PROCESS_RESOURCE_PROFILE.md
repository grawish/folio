# Process memory and CPU measurements

Folio has two recorded three-cycle memory and CPU measurements: the earlier compiler-limit baseline and the qualified cache/recovery app. Both prepare a fresh compiler, build one-page and 100-page documents, visit distant pages and export PDFs. These observations help direct performance work; they do not establish a maximum for every document or finish production acceptance.

## Qualified cache/recovery app: 28 September

The same published observer and workload were run against the app qualified at `05f58fe` (ASAR `21deec45a0be129a63d3d8b14a71f555000b9b40a0dbf5c6e6ebcfe0ff8e5144`), using source `1210eba`. No application or measurement code changed for this run. The observer executable also matches the baseline byte for byte. This includes the newer runtime verification, recovery scheduling, compiler-request limits and cache retention.

All nine exported PDFs were independently parsed, including every page marker in the three 100-page documents. All 443 snapshot memory sums, Mach-timebase CPU accumulations, phase boundaries and peaks were recomputed independently. The app exited, and no Tectonic, Biber or compiler watchdog appeared in the settled-idle snapshots. The same M4 Pro and one-page/100-page synthetic workload were used; normal desktop work continued, OS caches were not purged, and no other local Folio build, native suite or benchmark ran concurrently. Hosted qualification ran on a separate GitHub machine.

| Observed phase | Samples of the workload | Elapsed min–max, seconds | Observed CPU min–max, CPU-seconds | Peak summed RSS, MiB | Peak summed footprint, MiB |
| --- | --- | --- | --- | --- | --- |
| First preparation, after automation attaches | 1 | 44.380–44.380 | 18.060–18.060 | 910.2 | 566.9 |
| One-page builds, including returns | 6 | 1.379–1.428 | 1.205–1.493 | 850.3 | 726.1 |
| 100-page builds | 3 | 1.560–1.570 | 1.701–1.767 | 827.3 | 710.1 |
| Page visits, including the specified dwells | 3 | 1.581–1.602 | 0.146–0.163 | 654.8 | 566.4 |
| Settled idle intervals | 10 | 2.503–2.611 | 0.004–0.082 | 653.9 | 561.6 |

The complete sampled span is 87.628 seconds with 32.774 observed CPU-seconds. Peak summed RSS is 910.2 MiB and peak summed footprint 726.1 MiB, reached at different times. All four existing fixture investigation thresholds below pass. These are accounting sums and sampled lower-bound CPU observations, not unique physical RAM, enforced app limits or worst-case guarantees.

Fresh compiler preparation took 44.380 seconds in this run versus 34.190 seconds in the earlier baseline. The nine ordinary builds took 1.379–1.570 seconds here. These runs were taken at different times and many implementation changes apart; neither difference establishes a causal speedup or regression. Initial preparation remains a priority for repeated, paired subprocess measurements. Returning to one page leaves peak idle RSS of 626.1, 636.2 and 653.9 MiB across the three cycles; three samples do not establish a leak or long-session retention.

The closed synthetic profile contains 4,064 regular files totaling 409.4 MiB of logical file sizes. This excludes the app installation, filesystem allocation and external caches. Observer collection took at most 184.862 ms, with a maximum sample gap of 384.798 ms; the observer consumed 1.421 CPU-seconds outside the app tree. Uneven sampling can miss short-lived work and peaks.

See [all phases and limits](performance/process-tree-current-summary.json), [compressed original snapshots](performance/process-tree-current.json.gz) and [independent verification](releases/current-process-profile-verification.json). The original record below is retained unchanged. Upper-bound images/history, longer sessions and minimum supported-device measurements remain required before adopting release-wide budgets.

## Earlier baseline: recorded app and workload

The application is the unchanged compiler-limit package from source `349d6ce`, with app.asar SHA-256 `690e78289d9b79d5c05084fc809d7da2497652943523307deb733e1c690e721d`. Its runtime manifest is unchanged. The observer is a developer tool, built separately with the installed macOS SDK; it is not added to the application or installer.

The host is an Apple M4 Pro, 14 logical CPUs, 48 GiB RAM, Darwin 27.0.0 and Node 24.21.0. The app viewport is 1480 × 960 at device-pixel ratio 1. A fresh synthetic app profile prepares its own compiler; OS caches are not purged. Each cycle builds one page, builds 100 simple text pages, visits pages 100, 50 and 1 with a 500 ms dwell at each, then returns to a one-page document. Automatic compilation is off; actual keyboard replacement and the ordinary Compile/Export actions are used. No AI account is called.

All nine exports were inspected after sampling with pypdf 6.10.0. Page counts, first/last page markers and file hashes pass. The ordinary viewer never exceeded four rendered pages or its existing canvas-pixel budget during the recorded observations. There were no renderer errors. App and script hashes were checked before and after the run.

## Results

The table reports peaks within each group of observed phases. RSS and physical footprint peak at different moments and must not be added together. They sum per-process accounting values; shared pages/surfaces can appear in more than one process, so neither column means unique physical RAM used by the whole app.

| Observed phase | Samples of the workload | Elapsed time | Observed CPU time | Peak summed RSS | Peak summed physical footprint |
| --- | --- | --- | --- | --- | --- |
| Fresh preparation through first PDF, after automation attaches | 1 | 34.190 s | 19.386 CPU-s | 862.5 MiB | 514.9 MiB |
| One-page builds, including returns from 100 pages | 6 | 1.879–1.943 s | 1.792–1.917 CPU-s | 920.8 MiB | 694.7 MiB |
| 100-page builds | 3 | 2.076–2.107 s | 2.134–2.170 CPU-s | 895.5 MiB | 692.4 MiB |
| Three page visits, including the deliberate dwells | 3 | 1.560–1.604 s | 0.149–0.165 CPU-s | 739.8 MiB | 665.7 MiB |
| Settled idle intervals | 10 | 2.502–2.577 s | 0.009–0.092 CPU-s | 736.8 MiB | 655.3 MiB |

Fresh preparation is **not editable-startup latency**: Folio can open editing while preparing the compiler. Build timings here include keyboard input and completed current-PDF checks and are separate from the earlier 60-edit automatic-preview benchmark. Navigation timings include the prescribed dwell time.

The 82.038-second sampled span contains 421 snapshots and 37.997 observed CPU-seconds. CPU-seconds sum work across processes/cores; they are not wall-clock seconds. The largest observed idle interval averaged 3.7% of one CPU core. These CPU totals omit work that finishes between snapshots or after a process's last observation.

At the 920.8 MiB RSS peak, the main app reported 302.4 MiB, the renderer 282.8 MiB, Tectonic 189.0 MiB and two other Electron helpers about 146.7 MiB combined. This identifies where to investigate, not which allocation caused the peak. PDF workers run within the renderer and are not separate sampled processes.

After returning to one page, peak idle RSS across the three cycles was 649.4, 734.7 and 680.3 MiB; footprint was 568.7, 618.0 and 565.6 MiB. Growth was not monotonic in this small run. It neither proves a leak nor establishes that long sessions, large images or large histories are bounded.

The closed synthetic app profile contained 4,062 regular files totaling 409.4 MiB of logical file sizes. Its retained runtime accounted for 378.5 MiB and build cache 23.3 MiB. This excludes the app installation, filesystem allocation/metadata and external caches. It is one end-of-run inventory, not a storage-growth rate or retention guarantee.

## Measurement method and calibration

`scripts/sample-mac-processes.c` reads only a selected root PID and recursively discovered descendants using the public `libproc` interfaces. It gathers resident size, physical footprint and CPU counters. Parent checks restrict discovery to that tree; PID plus process birth time distinguishes reuse. Truncated enumeration and unexpected access failures stop the measurement. Snapshots are not atomic, and very short-lived or reparented processes can be missed.

The CPU values require the Mach timebase: this host reports a ratio of 125/3. The observer retains raw ticks and converts with integer arithmetic before reporting seconds. Apple's [resource structure](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/sys/resource.h), [libproc wrappers](https://github.com/apple-oss-distributions/xnu/blob/main/libsyscall/wrappers/libproc/libproc.c) and [kernel accounting](https://github.com/apple-oss-distributions/xnu/blob/main/osfmk/kern/bsd_kern.c) describe the underlying interfaces. Child-CPU accounting fields are not added, which avoids counting descendants twice. Initial CPU counters for pre-existing processes are excluded; the last observed counters of exiting processes are retained.

The native calibration creates a parent, child and grandchild plus an unrelated sibling. A touched 64 MiB allocation must increase observed grandchild RSS, and 0.8 CPU-seconds of work must agree with the grandchild's own Node CPU measurement. The sibling must be absent. The final focused control observed 0.810 CPU-seconds and 73.4 MiB RSS growth, including runtime overhead. An earlier control failed because raw ticks were incorrectly treated as nanoseconds, undercounting CPU roughly 41.7 times. That error was corrected before either app run; both failing control logs are retained in the verification record.

The snapshot interval is 200 ms plus collection/scheduling overhead. Median collection time was 4.389 ms, maximum collection time 54.786 ms and the longest sample gap 257.025 ms. The helper processes consumed 1.211 CPU-seconds total and the external Playwright harness 1.280 CPU-seconds during the measured workload. They are outside the observed app tree but add load to the host. No process disappeared during the actual snapshot reads; that does not rule out children living entirely between reads. The desktop was not otherwise isolated.

## Initial investigation thresholds

For a repeat of **this fixture on this reference Mac**, investigate summed RSS above 1.5 GiB, summed physical footprint above 1 GiB, settled observed CPU above 10% of one core, or an individual ordinary build above 3 observed CPU-seconds. These provide headroom over this baseline and are provisional regression thresholds, not operating-system caps or universal product guarantees.

Before turning these into release-wide budgets, repeat with supported upper-bound PDFs/images/history, long editing sessions, cold caches and the minimum supported device/OS. Compare main-process heap/runtime buffers, renderer/PDF memory and other Electron helpers separately. Preserve normal garbage collection during acceptance; an explicit-GC experiment must be labeled separately. Historical storage still needs a retention policy, and aggregate memory/CPU/disk control remains open. The current [compiler limits](COMPILER_RESOURCE_LIMITS.md) address different, narrower process resources.

## Reproduce and inspect

Run after installing the normal developer dependencies and macOS command-line tools. Point `FOLIO_PYTHON` at an environment containing the pinned PDF test requirements. Keep other native tests, builds and benchmarks off this Mac while measuring.

```sh
node --import tsx --test tests/mac-process-sampler.test.ts
FOLIO_PYTHON=/path/to/python3 node scripts/profile-process-resources.mjs \
  release/compiler-limits/mac-arm64/Folio.app/Contents/MacOS/Folio 3
```

The native observer is compiled into the new ignored result directory. No observer binary is committed or installed into Folio. A preliminary one-cycle smoke run is retained separately; the recorded three-cycle run uses the final navigation-dwell workload.

See the [summary and every phase](performance/process-tree-summary.json), [compressed raw snapshots](performance/process-tree-baseline.json.gz) and [verification record](releases/process-profile-verification.json). Every memory sum, CPU accumulation, phase boundary/peak, PDF hash and compressed-data round trip was independently recomputed. The raw data is gzip-compressed JSON and contains only this synthetic run's process metrics and artifact paths. These results are descriptive observations, not percentiles or complete production qualification.

## Longer repeated-use measurements

The profiler now offers an explicit `--long-session` mode with 1–120 cycles. The ordinary 1–5-cycle mode and original raw baselines remain available. Both modes use the same native observer and one-page → 100-page → navigation → one-page workload, with ordinary garbage collection and a fresh isolated synthetic app profile.

```sh
FOLIO_PYTHON=/path/to/python3 node scripts/profile-process-resources.mjs \
  /path/to/Folio.app/Contents/MacOS/Folio 120 --long-session
```

In long-session mode, read-only storage observations run after startup, every ten cycles, at the final cycle and after the app closes. Each observation retains relative metadata entries and grouped logical file totals. Directory enumeration is bounded to 50,000 entries and depth 16; observed symbolic links are counted without traversal. The collector fails rather than publishing silently truncated totals. Scans have separate phase markers outside measured builds/navigation. This is a non-atomic observation of an owned synthetic profile, not a hostile-filesystem boundary or an allocated-disk-block measurement.

The scan's filesystem I/O and the external measurement harness still add host load. PDF inspection runs after sampling. Earlier measurements retain their original script hashes and scope. A longer repetition of this small-text workload does not cover maximum image/history inputs, real AI-provider sessions, all supported devices or every source of retained data. Results must be independently recomputed before using them to adjust a resource policy or claim a leak or budget pass.

## 120-cycle result — 28 September 2026

The complete 120-cycle run finished and its evidence passes independent verification. **Two CPU investigation thresholds fail**; the memory thresholds pass. This is a measurement result, not an application-wide resource-acceptance pass.

The unchanged local Folio-icon app ran for a 1,679.404-second sampled span (about 28 minutes) on the development M4 Pro with 48 GiB RAM and macOS 27.0. The instrument source is `27ff98ab429c0aaa87f83e554612f3bc31c36bfa`; its app archive and runtime match the separately qualified combined-notice application. The exact package and earlier icon comparison remain recorded in [the app verification](releases/mac-app-icon-verification.json).

All 360 exported PDFs and all 12,240 pages were independently parsed. The verifier recomputed 8,910 process snapshots, 1,215 phase boundaries and 14 storage observations. All 720 canvas observations stay within the existing five-page/16-megapixel bounds. No compiler or watchdog was observed during idle snapshots. The app exited before the closed-profile filesystem comparison.

| Observation | Result | Existing investigation threshold |
| --- | --- | --- |
| Peak summed RSS | 1,094.7 MiB | Below 1.5 GiB: passes |
| Peak summed physical footprint | 876.1 MiB | Below 1 GiB: passes |
| Ordinary build CPU, all 360 builds | 1.228–3.735 observed CPU-seconds | Below 3 CPU-seconds: **one failure** |
| Highest of 361 idle intervals | 13.30% of one core | Below 10%: **one failure** |
| Whole sampled span | 629.025 observed CPU-seconds | Descriptive total; no whole-session threshold |

The one-page builds have a median elapsed duration of 1.389 seconds (range 1.357–3.391); 100-page builds have a median of 1.557 seconds (range 1.546–2.579). These include automated source entry and current-PDF readiness. They are not the reference-corpus post-debounce p95 benchmark. Fresh preparation through the first PDF takes 47.827 seconds here; editing can become available earlier.

### Investigate the CPU outliers

Cycle 73's return-to-one-page build uses 3.735 observed CPU-seconds over 3.391 elapsed seconds. The main Folio process contributes 3.290 CPU-seconds, the renderer 0.197 and Tectonic 0.168; remaining helpers account for the rest. Cycle 112's return-idle interval uses 0.333 CPU-seconds over 2.503 seconds, predominantly the renderer (0.302 CPU-seconds). Neither interval has a vanished process during observer reads, and their maximum collection times are below 9 ms.

These process totals do not identify JavaScript allocation sites, garbage collection, filesystem work or a causal defect. Retain both outliers. Next capture main-process CPU traces around builds with a larger retained history and renderer CPU/allocation traces around repeated PDF replacement. Compare with the same workload and ordinary garbage collection before changing code or thresholds.

### Memory over the session

Each row below is the median of ten per-cycle return-idle medians. Normal garbage collection remains enabled; no explicit collection is forced.

| Cycles | Summed RSS | Summed footprint |
| --- | --- | --- |
| 1–10 | 654.5 MiB | 452.2 MiB |
| 31–40 | 791.4 MiB | 511.6 MiB |
| 61–70 | 806.9 MiB | 511.1 MiB |
| 91–100 | 852.3 MiB | 553.0 MiB |
| 111–120 | 864.7 MiB | 563.1 MiB |

Late return-idle memory is higher than early memory, although the last block decreases from cycles 101–110. Across all return-idle snapshots in the first and last ten cycles, renderer median RSS rises from 259.7 to 435.2 MiB and main-process median RSS from 250.8 to 287.5 MiB. Per-process medians do not add to the median of totals. This is evidence to investigate retained renderer resources; it neither establishes a leak nor demonstrates a stable long-session plateau. Distinguish editor undo, saved-version state, PDF objects/workers and normal heap capacity with allocation evidence before choosing a fix.

### Disk growth is retained history in this fixture

The profile grows from 429,015,828 to 439,375,583 logical file bytes by cycle 120, and contains 439,363,538 bytes after closing. The workspace group grows by 10,362,423 bytes. Its 361 retained versions comprise the initial template and the 360 measured builds; every exported PDF hash matches a retained history PDF. This growth preserves user-visible source/PDF history. Do not treat it as disposable cache.

The `builds` group remains at 24,451,466 bytes and `runtimes` at 396,845,472 bytes in every recorded storage observation. Read-only metadata scans take 108.8–158.4 ms, median 136.8 ms. This run remains below the separate [history admission policy](HISTORY_STORAGE.md) of 1,000 versions/64 MiB and does not test that boundary. It does not include runtime upgrades, repair churn, large images, imports or many separate projects.

### Measurement limits and retained data

The host was not isolated: normal desktop, browser, documentation and downloaded-evidence verification work continued. No other local Folio build, native suite or benchmark ran during sampling. Website browser checks began after the profiler exited. The observer consumes 27.740 CPU-seconds and the automation harness 30.817 CPU-seconds outside the measured app tree. The longest sample gap is 778.5 ms, maximum collection is 578.5 ms, and six processes disappear during snapshot reads. Short-lived work and between-sample peaks may therefore be missed. RSS and footprint remain sampled accounting sums, not unique physical RAM or enforced quotas.

See [all raw observations](performance/process-tree-long-session.json.gz), [summary](performance/process-tree-long-session-summary.json), [phase/memory/storage analysis](performance/process-tree-long-session-analysis.json), [process attribution and history comparison](performance/process-tree-long-session-followup.json), and [independent verification](releases/long-session-profile-verification.json). Earlier raw baselines and the preliminary one-cycle instrument smoke remain preserved. This experiment advances repeated-use evidence; upper-bound inputs, supported-device coverage, CPU outliers, memory retention and final product budgets remain open.


## Diagnostic V8 traces

Use the optional diagnostic tool only with a completed synthetic 120-cycle fixture. It copies the closed profile into a new ignored directory, compares every source/copy file hash and verifies that the original profile remains unchanged after the run. It never opens that historical profile for app writes.

```sh
FOLIO_PYTHON=/path/to/python3 node scripts/profile-v8-resources.mjs \
  /path/to/Folio.app/Contents/MacOS/Folio \
  test-results/process-profile-YOUR_COMPLETED_RUN 20
```

The explicit limit is 1–20 cycles. Each cycle retains main and renderer V8 CPU profiles at a requested 1 ms sampling interval, while the renderer allocation sampler uses a requested 64 KiB interval. Periodic heap/DOM observations and the existing native process observer provide additional context. Three current PDFs are exported and checked per cycle. Source/app hashes, embedded Node/Electron/Chromium/V8 versions, the original profile hash and every trace hash are retained with the result. No heap snapshot or explicit garbage collection is requested.

These are diagnostic runs with additional overhead. New processes restore the saved history, not the preceding session's live heap. V8 CPU profiles describe selected isolates rather than total native-thread or subprocess CPU; allocation sampling estimates selected live allocations since sampling started, not the full retained heap, PDF-worker heaps or GPU/native memory. Do not compare these timings directly with normal-run acceptance thresholds or call an allocation sample a leak. Use call stacks and source maps to propose a narrow change, then test that change with ordinary instrumentation and preserved correctness checks.

Protocol references: [Node Inspector CPU profiling](https://nodejs.org/api/inspector.html#cpu-profiler) and [V8 HeapProfiler methods](https://chromedevtools.github.io/devtools-protocol/tot/HeapProfiler/). Actual method support is checked against the packaged application's embedded versions during the instrument smoke. The first one-cycle smoke captures both CPU profiles and renderer allocations, verifies all three exported PDFs, and leaves the historical profile and packaged inputs unchanged. The completed 20-cycle result follows; the earlier CPU-threshold failures remain open.


### Completed 20-cycle diagnostic

The unchanged Folio-icon package ran 20 additional cycles from an exact copy of the closed 120-cycle synthetic profile. The copied history contains 361 versions at startup, but the app starts fresh processes and heaps. Instrument source `7bc21040e9cca366247761437472e0917cabceab` records 40 CPU profiles, six heap/allocation observations, 1,486 native snapshots and 242 phase markers. All 60 exports and all 2,040 PDF pages pass independent parsing; all 120 canvas observations stay within the existing limits. The original profile's 5,623 metadata entries and every file hash remain unchanged. The app exits after the run.

The packaged main-process source map is present. The renderer map is reproduced with an in-memory Vite build, and accepted only when its JavaScript bytes exactly match the packaged renderer. Every mapped application source also matches the checked-out file. The analyzer never writes the app or historical `dist` output. The separate Python verifier recomputes every raw CPU sample's leaf weight, heap tree/sample totals, native memory sum, Mach CPU accumulation and phase marker. It verifies source hashes but does not independently implement source-map decoding.

Across the 20 cycles, the largest named main-isolate context is `electron/core/runtime.ts`, at **16.081 seconds of V8 sample weight**. Save I/O accounts for 0.379 seconds, workspace code 0.330 seconds and garbage collection 0.185 seconds. Runtime verification therefore remains the strongest identifiable main-isolate optimization candidate in this diagnostic. It includes native hashing and filesystem calls under its stack; the current implementation deliberately verifies every file on each acquisition. This observation does not establish the cause of the earlier cycle-73 outlier.

These values sum V8 sampling intervals assigned once to the nearest mapped stack ancestor. They include scheduling effects and are **not kernel CPU-seconds, precise function durations or percentages of whole-app CPU**. The main trace also has 250.740 seconds labeled idle and 2.963 seconds labeled program. Worker threads, compiler subprocesses and much native/GPU work are outside these isolate traces. Do not add these weights to the native process counters.

The renderer's named contexts include React (0.426 seconds), CodeMirror view (0.407 seconds), PDF.js (0.375 seconds) and garbage collection (0.249 seconds). These relatively small named totals coexist with 7.030 seconds labeled program and 262.938 seconds idle. They do not explain the earlier renderer idle spike by themselves.

| Observation | Renderer used JS heap | DOM node counter | JS event listeners | Sampled allocation tree estimate |
| --- | ---: | ---: | ---: | ---: |
| Ready | 8.54 MiB | 897 | 472 | 0.00 MiB |
| Cycle 1 | 12.23 MiB | 2,293 | 428 | 1.63 MiB |
| Cycle 5 | 16.89 MiB | 9,152 | 655 | 2.27 MiB |
| Cycle 10 | 14.94 MiB | 17,269 | 463 | 3.06 MiB |
| Cycle 15 | 19.30 MiB | 25,841 | 669 | 3.56 MiB |
| Cycle 20 | 13.53 MiB | 33,723 | 245 | 4.48 MiB |

DOM nodes rise while used JS heap falls after cycle 15. The final sampled allocation tree assigns about 1.13 MiB to CodeMirror view, 0.98 MiB to CodeMirror state, 0.38 MiB to React and 0.19 MiB to PDF.js; 1.43 MiB has no mapped source context. These are sampled estimates, not complete retained sizes or retaining paths. The DOM counter does not distinguish connected from detached nodes, and the initial sample starts after the existing document is loaded. Node counts cannot prove a leak or assign it to the PDF viewer. The next diagnostic must distinguish undo history, editor views, PDF text layers, ordinary collection and automation-held objects before changing ownership or retention.

Run the analyzer and independent verifier from the matching source checkout after collection:

```sh
node scripts/analyze-v8-resources.mjs test-results/v8-profile-YOUR_RUN /path/to/Folio.app
# Python with scripts/template-test-requirements.txt; also needs the original seed and exports.
python3 scripts/verify-v8-resources.py test-results/v8-profile-YOUR_RUN /path/to/Folio.app
```

The verifier writes the public summary, compact raw archive and verification record. The archive preserves the report, all 46 CPU/allocation profiles and the full analysis byte for byte. It excludes the copied app profile, app binaries, PDFs and reproducible source maps. The synthetic PDFs and seed remain local for the full independent check. Embedded versions are Node 24.21.0, Electron 44.4.5, Chromium 152.0.7977.130 and V8 15.2.124.28-electron.0.

See [summary and all context totals](performance/v8-resource-summary.json), [raw traces and analysis](performance/v8-resource-traces.tar.gz) and [independent verification](releases/v8-resource-verification.json). Ordinary desktop work continued on the same M4 Pro/48 GiB development Mac; the host was not isolated. Profiling overhead makes this a separate diagnosis, not a timing comparison, speedup, memory-retention fix or production budget pass. The original 120-cycle observations and failures remain unchanged.


### Renderer retaining paths and input control

Two completed five-cycle runs of the unchanged app use the same synthetic seed, instrument source `bf98091`, script hashes and embedded runtime. One uses the existing native `keyboard.insertText` replacement; the other sends a synthetic paste event to CodeMirror's existing paste handler. Both select the complete document first. The control does not read or change the system clipboard and is not a physical-paste or IME acceptance test.

After the ordinary workload and CPU/allocation sampling stop, a separate diagnostic counts connected DOM nodes, explicitly collects garbage and takes local heap snapshots. It then switches to Chat and finally creates a new synthetic project. Code remains mounted while hidden in Chat. Changing the project replaces the editor session and PDF. These destructive test actions apply only to a disposable copy, and all original seed files remain unchanged.

| Checkpoint | Native insertion: DOM counter after GC | Paste handler: DOM counter after GC | Detached snapshot nodes, native / paste |
| --- | ---: | ---: | ---: |
| Code after five cycles | 8,771 | 443 | 6,766 / 1 |
| Chat, existing editor hidden | 8,812 | 484 | 6,766 / 1 |
| New project, new editor session and PDF | 1,234 | 1,226 | 22 / 22 |

The first Code checkpoint has 400 connected nodes in the native case and 392 in the paste control. The snapshot reader finds one shortest path from the synthetic root while excluding weak edges. Of 6,766 detached native-case nodes, 6,345 have that path through `blink::UndoStack` and 420 through `blink::TypingCommand`. They include old CodeMirror lines, text and spans. The selected graph paths therefore locate this workload's retention in native browser editing history. They are not dominators, complete retained sizes or proof that every object has only one owner.

Explicit collection and switching to Chat keep those nodes alive. After changing projects, none of the original detached snapshot identifiers remain in the detached set, and the native-undo path groups are empty. Both new-project snapshots have 22 detached PDF text spans referenced from the current page's text-layer state. These smaller counts require their own lifecycle context; detachedness alone does not establish a leak.

The two runs produce 15 matching document pairs. Independent checks compare every one of the 510 page pairs for extracted text, page boxes and link targets/rectangles. Every export matches its retained history PDF, every saved TeX file matches the intended input hash, and all 361 original history versions survive in each copied workspace. The normal native snapshots and V8 trace accounting are also independently checked. Three graph-reader controls cover a misleading weak shortcut, an unreachable weak-only node, invalid node offsets and changed snapshot bytes.

This is **one sequential input-method comparison on one development Mac**. It narrows the cause of these retained editor nodes, without explaining all earlier RSS growth or the CPU outliers. Preserve the native-replacement stress case; replacing it with paste and calling the budget fixed would hide the observed behavior. Next measure ordinary character typing, composition and agent-driven source changes separately, and evaluate releasing a hidden editor view while preserving CodeMirror document/undo state, per-file history, selection, focus and external changes. Do not clear user undo history or force collection in the product to improve a graph.

```sh
# Each command starts from a fresh exact copy of the historical synthetic seed.
FOLIO_PYTHON=/path/to/python3 node scripts/profile-v8-resources.mjs /path/to/Folio.app/Contents/MacOS/Folio test-results/process-profile-SEED 5 --retention
FOLIO_PYTHON=/path/to/python3 node scripts/profile-v8-resources.mjs /path/to/Folio.app/Contents/MacOS/Folio test-results/process-profile-SEED 5 --retention-paste
python3 scripts/analyze-renderer-retention.py test-results/v8-profile-RUN
node scripts/analyze-v8-resources.mjs test-results/v8-profile-RUN /path/to/Folio.app
# Use a distinct evidence prefix to preserve the published 20-cycle result.
python3 scripts/verify-v8-resources.py test-results/v8-profile-RUN /path/to/Folio.app renderer-retention-native
```

Full heap snapshots are bounded to 128 MiB each and remain local. Published [comparison and representative paths](performance/renderer-retention-comparison.json), [native-input summary](performance/renderer-retention-native-summary.json), [paste-control summary](performance/renderer-retention-paste-summary.json), and their [native](releases/renderer-retention-native-verification.json) / [paste](releases/renderer-retention-paste-verification.json) verification records retain exact identities and limits. Compact [native traces](performance/renderer-retention-native-traces.tar.gz) and [paste traces](performance/renderer-retention-paste-traces.tar.gz) exclude full heaps and profile copies. The initial five-cycle trial completed two snapshots, then failed because its template selector omitted “The”; that failed report, log and snapshots remain retained and excluded from the completed comparison. Its original top-level no-GC wording applied to the sampled workload; the added post-workload diagnostic did request collection. The completed runs explicitly describe that separation.

The snapshot detachedness values follow [V8's embedder-graph states](https://chromium.googlesource.com/v8/v8.git/+/refs/heads/13.1.95/include/v8-profiler.h). The analyzer reads the actual snapshot's field/type tables, checks every node/edge and retains its source hash. This is a diagnosis with an input control, not a shipped optimization or completed resource acceptance.
