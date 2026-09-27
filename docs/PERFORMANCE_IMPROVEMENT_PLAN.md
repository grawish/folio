# Performance investigation and improvement plan

Measured 26–27 September 2026. The largest measured delays are first-time runtime preparation and repeated runtime verification. This report contains backend and packaged-app measurements with a prioritized plan. It does not claim that every app workflow or the plan's reference-device budgets have passed.

## One live Claude edit with PDF review

The [27 September live verification](releases/claude-live-verification.json) measures a real subscription request in the source-built app at `6bd235f`. A box and note on page two ask to change only “Projects” to “Selected Projects.” The compiler is already prepared, and the initial document has already been built. Claude Code 2.1.282 uses the `sonnet` alias and returns `claude-sonnet-5`.

| Stage reported by the app | Time |
| --- | ---: |
| Agent setup | 0.112 s |
| Provider edit request | 3.981 s |
| Local compilation | 2.006 s |
| Candidate PDF rendering | 0.129 s |
| Provider visual review | 4.043 s |
| Complete recorded agent execution | 10.361 s |
| Send through the test's verified result observation | 11.109 s |

The recorded stage sum is 10.273 s; the total also includes about 0.088 s outside those stage timers. The test observation includes UI/IPC work and a one-second polling interval, so its extra time is not an isolated UI-latency measurement. Saving, export, reopening, first-time compiler preparation and the separate Settings image check are outside that chat interval.

The two provider calls account for about 77% of this execution. Measure them separately across repeated requests before changing the routing policy; check that any faster model still preserves exact edits and completes PDF review. Local compilation is the next largest measured stage. Keep the integrity checks and investigate the runtime-verification experiments below. Do not skip visual review for PDF notes to meet a speed target.

This is one successful complete workflow on one development Mac/account, not a median, p95, model comparison or performance guarantee. Two earlier attempts completed the live edit but failed test-harness restart assertions; they are retained separately and excluded from this complete-workflow result. No production code changed for this measurement.

## Reproduce the baseline

```sh
node --import tsx scripts/profile-runtime.mjs 3
```

Run after native tests finish, with no other Folio benchmark running. The script creates isolated profiles under `test-results/`, invokes the production RuntimeManager and sandboxed Compiler, records filesystem operation waits, and keeps each sample. It does not change normal user app data. The runtime must already be prepared in the development workspace.

The [raw measurements](performance/runtime-baseline.json) include source/manifest/script SHA-256 values, individual stage and method timings, filesystem counts, host CPU and sampled RSS. No Git commit existed yet, so the file hashes identify the measured implementation. The local run is also retained in `test-results/runtime-profile-vCHWih/`.

Hardware: Apple M4 Pro, 14 logical CPUs, 48 GiB RAM, arm64 Darwin 27.0.0, Node v24.21.0. Each sample uses a new managed runtime and TeX cache. OS disk/execution caches were not purged. All three samples run in the same Node host; later memory readings include that host's retained allocations. These are backend timings, not Electron window startup or full process-tree memory measurements.

## What takes time

| Operation | Sample 1 | Sample 2 | Sample 3 | Observation |
| --- | ---: | ---: | ---: | --- |
| Fresh runtime initialization | 57.060 s | 40.698 s | 39.650 s | Median 40.698 s; the first sample has a much slower self-test |
| Source verification and durable copying, through staged checkpoint | 31.263 s | 30.798 s | 30.188 s | Consistently the largest preparation phase |
| Offline compiler/Biber self-test | 24.903 s | 9.061 s | 8.733 s | Large variation; do not discard the first observation |
| Initial full ready-status check | 1.047 s | 0.709 s | 0.697 s | Reads/verifies the selected runtime after preparation |
| First synthetic article build | 1.610 s | 1.489 s | 1.503 s | Includes runtime acquisition, a cold document format/cache and actual TeX |
| Later runtime initialization | 0.008 s | 0.008 s | 0.007 s | Finding the already prepared runtime is cheap |
| Later full ready-status check | 0.851 s | 0.733 s | 0.746 s | Integrity verification remains material on later starts |

The first two preparation rows overlap: copying and the self-test are parts of initialization. Do not add them to the initialization total.

Across nine changed-source warm builds, total latency is **0.842–0.999 s**. Their selected-runtime acquisition costs **0.700–0.846 s**, while the native TeX subprocess costs **0.123–0.150 s**. Runtime acquisition includes the full inventory/hash verification and pin/lease bookkeeping. This fixture therefore spends most of its warm build time before the TeX process starts. It is a small single-page article, not a bibliography-heavy or 100-page document.

The final native runtime qualification separately recorded **68.472 s from launch through first Save**. That is a single end-to-end UI observation with different fixture/state and includes user-interface actions. It must not be combined with the three backend samples to claim a common median or p95.

### Why copying is expensive

The manifest covers **3,982 files**: 3,979 files in `biber-cache`, plus Biber, Tectonic and the TeX bundle. The bibliography cache accounts for 247,211,520 bytes; Biber for 60,205,328; Tectonic for 53,998,928; and the bundle ZIP for 10,437,911. The runtime folder's regular-file content, including manifests/notices, is 372,393,760 bytes.

`RuntimeManager.install` verifies the installer copy, then uses four concurrent copying workers. Each copied file goes through write, file sync, rename and parent-directory sync. The profile observes **3,985 writes/file syncs and 3,985 directory syncs per installation**, including the three extra manifest/inventory/notice files. For the first sample, median file sync is 8.53 ms and median directory sync is 8.35 ms. Their accumulated waits are 34.05 s and 35.66 s respectively across concurrent workers. Those sums overlap and are not elapsed-time percentages. There are also thousands of opens/renames and 49,103 parent/file lstat calls during this phase.

This supports prioritizing the durable-copy path. It does not prove that dropping fsync, skipping parent checks or increasing concurrency arbitrarily would preserve correctness.

### Self-test uncertainty

The measured self-test runs an app-owned TeX document with Biber and bibliography output. It includes compiler-side verification and native execution. The current profile measures the whole probe, not TeX and Biber separately. Disk cache, first execution and OS executable validation may contribute to the first sample's extra delay; those are hypotheses requiring subprocess/event profiling, not established causes.

### Self-test subprocess observations

The enhanced `node --import tsx scripts/profile-runtime.mjs 5` records bounded stdout/stderr chunks with parent-process receipt times. Each trace must reproduce the compiler's returned log byte for byte and match its exit status. The final five fresh-profile measurements use unchanged application code at `91979f3` on the M4 Pro/48 GiB development Mac. All 25 native subprocess traces and all 3,982 files in each of the five prepared compiler copies were independently checked.

| Observed interval, five samples | Minimum | Median | Maximum |
| --- | ---: | ---: | ---: |
| Complete fresh preparation | 26.649 s | 27.108 s | 44.562 s |
| Initialization through the durable staged checkpoint | 17.941 s | 18.155 s | 18.487 s |
| Offline self-test, including its runtime check and cleanup | 7.964 s | 8.000 s | 25.673 s |
| Biber start message to the next TeX message | 4.849 s | 4.868 s | 22.189 s |
| Other time within the self-test | 3.106 s | 3.132 s | 3.484 s |

These intervals overlap; do not add the rows. The slow third sample's self-test contains a 22.189-second Biber-to-TeX interval. Copying stays comparatively stable, so the trace locates most of this run's variation around bibliography execution. The messages are observed at the parent: buffering, scheduling, native startup and surrounding engine work can contribute. This does not prove that Biber computation, macOS executable validation or archive unpacking is the cause.

The paired runtime comparison below now adds native CPU observations and checks every generated PDF. Preserve exact runtime identities, real Biber execution, sandbox restrictions and integrity checks while investigating the remaining delay. Do not remove the bibliography self-test or cache a successful verification indefinitely to hide it. Repeat any improvement in the complete app on supported Macs before changing a release claim.

The initial observer validation is retained separately: fresh preparation took 44.979 seconds and the self-test 25.354 seconds, including a 21.820-second Biber-to-TeX interval. A subsequent trial was stopped after a recorder bookkeeping fault was discovered; its console results are retained locally and excluded from the final five-sample dataset because it lacked the raw stage records. The corrected profiler retains incomplete samples and rejects missing samples. No application source changed during these trials.

OS caches were not purged; the validation and abandoned trial ran first. No other local Folio native suite or benchmark ran concurrently; ordinary desktop work, documentation and read-only hosted-artifact verification continued. Five samples are not a population p95, physical cold-start result or supported-device budget pass. These are backend observations, not full-window startup or an optimization speedup.

See the [summary and per-sample events](performance/runtime-stages-summary.json), [five raw samples](performance/runtime-stages.json.gz), [initial observer validation](performance/runtime-stage-observer-check.json.gz) and [verification](releases/runtime-stages-verification.json).

### Paired Biber runtime comparison

Five alternating pairs compare the default runtime with a fresh private copy made by the existing ad-hoc signing pipeline. The candidate uses the fixed-entry Biber launcher, relocated libraries and ad-hoc signatures. It changes 158 native files and the runtime identity; every non-code file remains identical. This measures complete runtime variants, not the launcher alone. The default compiler and application code were unchanged.

Run `node --import tsx scripts/profile-runtime.mjs 5 '/absolute/path/to/candidate-runtime'` on an Apple silicon Mac after preparing and verifying a separate candidate. The pairs run AB, BA, AB, BA, AB, with a new managed runtime and TeX cache for each sample. The profiler observes native descendants every 100 ms and retains five synthetic PDFs per sample. Sources correspond to base `2bda16c` with the measured profiler committed as `16dd089`; its exact hash is recorded separately because the collection started before that commit. Later report-wording changes do not change these retained measurements.

| Pair | Default fresh preparation | Candidate fresh preparation |
| --- | ---: | ---: |
| 1 | 26.227 s | 24.194 s |
| 2 | 45.674 s | 23.923 s |
| 3 | 27.787 s | 38.395 s |
| 4 | 27.648 s | 25.082 s |
| 5 | 28.072 s | 25.832 s |

| Interval or counter | Default median (range) | Candidate median (range) |
| --- | ---: | ---: |
| Complete fresh preparation | 27.787 s (26.227–45.674) | 25.082 s (23.923–38.395) |
| Through durable staged checkpoint | 18.032 s (17.009–18.451) | 17.886 s (16.773–18.761) |
| Offline self-test | 8.870 s (8.581–27.902) | 6.474 s (6.374–18.893) |
| Biber message to next TeX message | 5.679 s (5.375–24.435) | 3.398 s (3.282–15.463) |
| Observed Biber CPU | 0.710 s (0.661–0.749) | 0.415 s (0.396–0.465) |

The candidate is faster in four pairs, but 10.608 seconds slower in pair three. Its group median is 9.7% lower, which does not establish a consistent improvement or explain the large variation. Durable staging remains about 18 seconds despite the smaller candidate. These intervals overlap and must not be added together.

The sampled Biber CPU counters are much smaller than the elapsed marker intervals. Counters were recomputed independently using process ID, birth time and the kernel timebase; the profiling host and observer are excluded from the Biber total. These are lower-bound observations: short-lived work, final CPU after the last sample and system services outside the descendant tree can be missed. They support investigating startup, loading and waiting, rather than assuming the whole gap is bibliography computation.

A separate diagnostic pair ran Apple's `sample` for one second per observed Biber process. The default report contains 48 `_dyld_start` observations out of 49; the candidate report contains 66 `__fcntl` observations in library-loading stacks, including Perl module loading, and 18 `_dyld_start` observations. Some frames involve debugger notifications, which the sampling tool itself can affect. Neither report has a binary image list. These short, instrumented windows do not explain the entire delay or prove a code-signing service is responsible. The diagnostic pair is excluded from all five-pair timing statistics.

Independent checks verified all 50 compiler logs, 39,820 installed runtime file hashes and 3,306 native process snapshots. All 50 one-page PDFs have matching authored sources, extracted text and 100-DPI Poppler raster bytes for their document/revision group. The two source runtime manifests contain the same 3,982 keys, and only the 158 native files differ.

Next investigate library loading and waiting with longer, separate diagnostic observations and a controlled repeated-execution fixture; then repeat a justified change in the complete app. Keep the actual bibliography self-test and every integrity/durability check. Changing the default runtime also requires resource-pack compatibility and release qualification for the new pin, so this experiment does not change the shipped compiler.

These results come from one M4 Pro/48 GiB development Mac. OS caches were not purged, and a separate observer-validation pair ran first. No local Folio native suite or benchmark ran alongside the final pairs; ordinary desktop and light documentation/status work continued. This is not a population p95, production signing result, supported-device pass or complete-app speedup.

See [summary, PDF checks and per-pair statistics](performance/biber-runtime-comparison-summary.json), [raw measurements](performance/biber-runtime-comparison.json.gz), [candidate preparation](performance/biber-runtime-preparation.json.gz), [separate diagnostic records](performance/biber-runtime-diagnostic.json.gz) and [verification](releases/biber-runtime-comparison-verification.json).


### Resource observations

Sampled Node-host peak RSS is 342.8, 423.4 and 457.0 MiB. This includes instrumentation and retained allocations across samples, excludes native child-process memory and does not establish an application leak or memory-budget pass. Host CPU totals also exclude compiler children. Physical high-DPI rendering, whole-app CPU/memory and process-tree termination measurements remain required.

## Faster runtime preparation: directory flushes

The source implementation now flushes each copied file, then flushes each folder once, working from the deepest folders toward the runtime root. The copy remains unpublished throughout. Only after all workers and folder flushes finish does the app verify the complete copy, run its offline TeX/Biber check, write readiness and switch the active pointer. Readiness and pointer writes keep their separate immediate file/folder flushes. Cancellation or a failed flush leaves the previous compiler selected.

A matched five-sample run on the same M4 Pro/48 GiB host used `node --import tsx scripts/profile-runtime.mjs 5`, first at source `adfeb0a`, then with this change. Both runs used the identical script, compiler manifest, verifier, compiler and synthetic documents. The [before](performance/runtime-copy-before.json) and [after](performance/runtime-copy-after.json) records retain every sample and the exact implementation hashes. This task ran no local native tests or other Folio benchmarks concurrently; ordinary desktop work and read-only hosted-log review continued. OS caches were not purged.

| Measurement | Before | After | Change |
| --- | ---: | ---: | --- |
| Median verification/copy through the durable staged checkpoint | 29.061 s | 18.571 s | 36.1% lower |
| Median complete fresh preparation, including offline self-test | 39.053 s | 28.003 s | 28.3% lower |
| Folder flushes in the preparation/copy phase, each sample | 3,990 | 456 | Repeated parent flushes removed; intermediate folders included |
| File flushes in that phase, each sample | 3,985 | 3,985 | Every copied file still flushed |

Fresh preparation ranged from 37.790–56.452 seconds before and 27.142–46.060 seconds after. The slower first sample in each run remains included. These are backend measurements on one development Mac, not full-window startup, cold physical storage, a supported-device budget pass or a population p95. Warm runtime verification is unchanged. The copy improvement is below the plan’s 40% target; that target remains open.

Two new controls reject the old implementation and pass after the change: all files/folders must be flushed before readiness, and a failed deepest/intermediate/root folder flush must retain the exact old active copy. The 23 focused runtime/pack tests pass. Core repair and signed-pack installation also survive real process kills before the folder flush, after staging, after self-test and after pointer publication. These checks cover process interruption, not physical power loss. See [the implementation verification record](releases/runtime-copy-verification.json) for broader checks and their scope.

## Measure editing through the rendered PDF

The packaged preview profiler exercises Code view with real keyboard replacement, automatic compilation and the current PDF canvas/text layer. It uses all six layouts in A4 and US Letter, with five measured edits per variant. Each variant receives an untimed first build. A separate app profile keeps synthetic resumes and compiler preparation away from ordinary user data.

```sh
# Use Python 3.11+ with scripts/template-test-requirements.txt installed.
FOLIO_PYTHON=/path/to/python node scripts/profile-preview.mjs /path/to/Folio.app/Contents/MacOS/Folio 5
# Validate the measurement setup with one Classic A4 edit first:
FOLIO_PYTHON=/path/to/python node scripts/profile-preview.mjs /path/to/Folio.app/Contents/MacOS/Folio 1 --smoke
```

The renderer records the actual input event, visible compilation start/end, changed text, completed current preview and two subsequent animation frames using one clock. It reports the observed delay before compilation separately; it does not simply subtract an assumed 700 ms. A temporary wrapper around the existing native IPC handler passes the original event, arguments, result and errors unchanged. The wrapper records total native handling and the compiler's existing duration field, which includes runtime verification and preparation of the build snapshot. It uses Electron's private handler map only in this developer harness and fails if the expected handler is missing; it is not an application feature or a supported extension API.

Every sample checks the exact source received by the production handler, one successful matching revision, a saved history version, the new text in both the preview and actual PDF, one page and the selected paper dimensions. PDFs, all individual timings, failures, app/runtime/script/fixture hashes and host details remain in `test-results/preview-profile-*/`. A failed sample stops the run and remains recorded. PDF inspection runs after the timed interval. No AI provider is contacted.

The tests replace a complete small synthetic source document in one keyboard operation; they do not measure individual keystroke latency. Renderer timer lateness and frame gaps describe automation observations, not physical display or VoiceOver acceptance. The native handling interval includes validation, assets and history work as well as compilation. Its difference from the rounded compiler duration is combined overhead, not an isolated checkpoint measurement. Shared engine/OS caches, fixed case order and one development Mac limit generalization. Any reported 95th percentile is an empirical nearest-rank statistic over the retained samples, not a claim about all supported Macs.

The [60-sample record](performance/preview-warm-baseline.json) measures the unchanged local history-worker package from source `0ad984f`: app.asar SHA-256 begins `d15091a0fa95c525`. The full hash, successful final smoke, initial missing-tool failure and independently checked summaries are in [verification](releases/preview-performance-verification.json). All sixty edits preserve the exact source, produce the matching one-page PDF and pass text/paper checks with no renderer errors. The host is the same M4 Pro/48 GiB Mac, at a 1480 × 960 logical viewport and device-pixel ratio 1. No local native suite, other Folio benchmark or packaging ran concurrently; normal desktop/documentation work continued. Hosted qualification runs on another machine.

| Measured interval, 60 warm edits | Median | Empirical 95th percentile | Slowest |
| --- | ---: | ---: | ---: |
| Input to current PDF plus two renderer frames | 2.259 s | 2.308 s | 2.459 s |
| Input to displayed compilation start, including debounce | 0.732 s | 0.735 s | 0.745 s |
| Displayed compilation start to current PDF plus two frames | 1.530 s | 1.575 s | 1.726 s |
| Compiler-reported duration, including runtime verification/snapshot | 1.439 s | 1.488 s | 1.636 s |
| Other work within the native IPC handler | 7.20 ms | 8.70 ms | 11.79 ms |
| Displayed compilation end to current rendered-preview readiness | 60.7 ms | 67.4 ms | 69.2 ms |

The observed post-debounce 95th percentile is below the plan's three-second warm-preview target **for this recorded corpus and development Mac**. The data points to the native compiler path as the largest remaining warm-edit cost; it does not isolate runtime verification from TeX in this packaged run. The earlier backend stage measurements motivate investigating verification first. Individual stage medians/percentiles should not be added as if they came from a single sample.

Maximum renderer timer lateness per edit ranges from 9.8 to 26.6 ms, and the largest observed animation-frame gap is 18.8 ms. The timing includes source replacement, mutation observation and automation. These observations do not establish a typing-latency or whole-process memory/CPU budget, physical high-DPI behavior, cold-cache performance or acceptance of larger/multi-file/bibliography documents. The slower first Classic edit remains in the statistics.

## Actual packaged app startup

### Workspace opening before compiler readiness

The current implementation removes compiler preparation from workspace bootstrap. Bootstrap reads the compiler identity and restores the actual project; full preparation and inspection continue separately. The workspace can accept source edits, saves and chat drafts while Send, Compile and Export PDF remain blocked. All execution still obtains the ordinary verified runtime lease.

The first native source observation reaches recovered editing in **409 ms** with no active compiler pointer yet. The test edits source, drafts a message and saves the exact compiler pin before preparation finishes, then closes, reopens and verifies the saved draft/source and eventual PDF. It also retains the early-close-before-recovery and failed-recovery protections. This sample has a synthetic recovered project and an early interruption, unlike the complete fresh/prepared package pairs below; it does not establish a speedup percentage, p95 or supported-device budget. The current unsigned-package launch pairs below add repeated observations; controlled before/after and supported-device comparisons remain required. The [walkthrough and screenshot](tutorials/first-resume.md#work-while-the-pdf-builder-gets-ready) identify this as development-source behavior, not the published preview-4 flow.

### Current package: chat drafting before the first PDF

The 27 September measurement uses the unchanged PDF.js-notice development app, app.asar SHA-256 `b3101633e1a7c78fe37789efe98a94ed442e0f927da03709959a17eff9cfbe3a`. Five new isolated profiles each launch twice: first with no prepared compiler, then after a normal close. The enhanced profiler types a short synthetic chat draft, checks it survives reopening, and verifies the exact Classic A4 source and compiler selection after both closes. No AI request is sent.

```sh
node scripts/profile-app.mjs /absolute/path/to/Folio.app/Contents/MacOS/Folio 5
```

| Pair | Fresh: draft accepted | Fresh: current PDF | Prepared: draft accepted | Prepared: current PDF |
| --- | ---: | ---: | ---: | ---: |
| 1 | 0.835 s | 52.620 s | 0.428 s | 4.251 s |
| 2 | 0.457 s | 34.035 s | 0.425 s | 6.751 s |
| 3 | 0.508 s | 52.191 s | 0.604 s | 6.939 s |
| 4 | 0.461 s | 56.239 s | 0.525 s | 5.846 s |
| 5 | 0.397 s | 34.474 s | 0.477 s | 5.304 s |

The composer becomes enabled in **0.386–0.820 seconds** across all ten launches; a real draft is filled and checked in **0.397–0.835 seconds**. The compiler progress notice is still visible at workspace readiness in every case. All ten current PDFs render with the expected text and no renderer or sampler errors. Every pair retains the same source and exact compiler selection, and the prepared draft remains on disk. These observations support the separation of workspace readiness from compiler preparation on this Mac.

The median fresh first-PDF observation is **52.191 seconds**; the prepared median is **5.846 seconds**. First-PDF time remains material and variable. These end-to-end times do not isolate preparation, runtime verification, TeX, recovery or rendering, so they do not establish the cause of the spread. The earlier backend evidence still supports profiling preparation and runtime verification first. No application speed change was made for this measurement, and the older runs used different app inputs and did not type a draft; do not calculate a before/after improvement from these tables.

The profiler also reads Chromium's buffered paint entries. First contentful paint is **144–208 ms after renderer navigation**. This is a different clock origin from launch and can describe the loading screen; it is not complete workspace readiness or a physical-display measurement. The 1,089 Electron metric snapshots have peak summed working sets of **622.6–645.5 MiB** on fresh launches and **568.9–635.4 MiB** on prepared launches. Those sums exclude compiler children and can double-count shared pages.

The host is an M4 Pro with 48 GiB RAM on macOS 27.0. OS caches were not purged; ordinary desktop activity and light documentation/status work continued. No other local Folio benchmark or native test ran concurrently; the hosted qualification used a separate machine. Five pairs are descriptive observations, not a population p95, supported-device acceptance, cold-disk result or production signed-installer measurement. The historical preview-4 download is unchanged.

The [summary](performance/current-package-startup-summary.json), [all raw samples](performance/current-package-startup.json.gz) and [independent verification](releases/current-package-startup-verification.json) retain the exact source base, profiler/app/runtime/template hashes, host, timings and checks. The verifier recomputes every working-set sum, checks sample/time ordering, compares each final recovery/workspace file, and confirms the gzip round trip. All 39 compiled outputs and 3,982 compiler files match before and after the run. Event-level recovery/compile/render tracing, broader fixtures, supported Macs and whole-app resource budgets remain required.

### Earlier package baseline

A second profile measures the verified `import-recovery` app itself, identified by app.asar SHA-256 `d50fb514cc45ab7653c88a50365e128481ddd4f57d0794eacc89c6cca5b0aaa8`. The source/license/documentation publication changes do not alter that earlier measured artifact. Run:

```sh
node scripts/profile-app.mjs /absolute/path/to/Folio.app/Contents/MacOS/Folio 3
```

[Raw app measurements](performance/app-baseline.json) retain all six launches and sampled Electron metrics. Each fresh launch gets a new profile; its paired prepared launch follows a normal window close using that same profile. OS caches are not purged. These runs used the same M4 Pro host as the backend profile, after native UI tests had finished. Minor documentation/git work occurred on the host; no other app benchmark ran concurrently.

| Pair | Profile | First window | Composer enabled | Current PDF + text visible | Peak summed Electron working sets |
| --- | --- | ---: | ---: | ---: | ---: |
| 1 | fresh | 0.566 s | 58.427 s | 61.736 s | 619.2 MiB |
| 1 | prepared | 0.288 s | 2.134 s | 5.441 s | 565.5 MiB |
| 2 | fresh | 0.287 s | 42.505 s | 45.816 s | 622.9 MiB |
| 2 | prepared | 0.272 s | 1.612 s | 5.437 s | 563.3 MiB |
| 3 | fresh | 0.287 s | 43.038 s | 46.337 s | 622.5 MiB |
| 3 | prepared | 0.283 s | 1.682 s | 5.499 s | 571.0 MiB |

All six launches reached the real Classic template PDF with no renderer or sampler errors. Fresh composer readiness is 42.5–58.4 seconds, and the first PDF takes 45.8–61.7 seconds. Prepared composer readiness is 1.61–2.13 seconds, while the first current PDF takes 5.44–5.50 seconds. This supports the priority of separating editing readiness from first-time runtime preparation. It also identifies a roughly 3.3–3.8 second interval between composer readiness and the visible current PDF that needs renderer/compile phase profiling; the present measurement does not assign that entire interval to TeX.

Working-set numbers sum Electron's reported processes and may double-count shared pages. They exclude Tectonic/Biber children and are not a physical-memory or process-tree budget pass. CPU percentages are Electron's interval averages. Timing includes Playwright polling and instrumentation; three paired samples are not a reliable p95. `firstWindowMs` means the first window became available to automation, not a hardware measurement of its first painted pixel.

### Earlier guided-recovery package: five launch pairs

A later [five-pair run](performance/save-recovery-app-baseline.json) measures the guided-recovery package, app.asar SHA-256 `dd9b1edd74789abe7b5f2da19fb6a1c8139f036304170f5685840ec01bb2ccf5`, with the same profiling script and M4 Pro host. The app hash and script hash were unchanged throughout. Run:

```sh
node scripts/profile-app.mjs release/save-recovery/mac-arm64/Folio.app/Contents/MacOS/Folio 5
```

| Pair | Fresh composer | Fresh current PDF | Prepared composer | Prepared current PDF |
| --- | ---: | ---: | ---: | ---: |
| 1 | 59.354 s | 62.653 s | 2.126 s | 5.445 s |
| 2 | 41.358 s | 44.657 s | 2.134 s | 5.434 s |
| 3 | 41.371 s | 44.688 s | 1.691 s | 5.500 s |
| 4 | 40.365 s | 43.661 s | 1.687 s | 5.504 s |
| 5 | 41.863 s | 45.161 s | 2.173 s | 5.473 s |

All ten launches displayed the Classic template PDF and completed normal window close, with no renderer or sampler errors. Fresh composer readiness is 40.4–59.4 seconds; prepared readiness is 1.69–2.17 seconds. Peak summed Electron working sets were 616.5–626.5 MiB for fresh profiles and 562.7–602.1 MiB for prepared profiles. Full per-process samples, first-window and close observations are retained in the JSON and locally in `test-results/app-profile-LNJJsy/`.

Another installed Folio instance and ordinary desktop apps remained open; they were not part of this measured process set. No other Folio benchmark or local native suite ran concurrently. OS caches were not purged. This is a repeatability check on the current package, not a controlled before/after optimization comparison, an application-wide memory measurement, or a supported-device p95. The earlier three-pair record remains unchanged. The original preparation/editing-readiness priorities still apply; no startup optimization is claimed.

## Compiler cancellation and timeout measurements

On the same M4 Pro host (Darwin 27.0.0, Node 24.21.0), the follow-up [raw stop measurements](performance/compiler-stop-baseline.json) cover three samples each of cancelling a running TeX loop, cancelling while the real Biber child is present, and the production timeout stopping a TeX loop. Reproduce with:

```sh
node --import tsx scripts/profile-compiler-stop.mjs 3
```

The script invokes the unchanged production Compiler with the included verified runtime, sandbox and isolated build/cache folders. It observes the actual spawn, process-group SIGKILL and child close, and samples only that compiler's process group. Cancellation happens after the target process has been observed for at least 150 ms. The timeout scenario uses a one-second timeout to exercise the same production mechanism without waiting 30 seconds per sample. This is backend instrumentation, not an end-to-end click or Electron measurement.

| Scenario, three samples each | SIGKILL to child close | Cancel call to return | SIGKILL to observed empty process group |
| --- | ---: | ---: | ---: |
| Cancel running TeX | 2.1–2.3 ms | 6.8–7.5 ms | 64.9–82.4 ms |
| Cancel TeX with Biber child | 3.0–3.7 ms | 7.9–9.2 ms | 64.5–66.0 ms |
| One-second timeout | 2.9–3.5 ms | Not applicable | 46.3–84.4 ms |

All nine runs observed the production SIGKILL, the expected cancelled/error result and an empty compiler group after completion. Both Tectonic and Biber were present in all three bibliography samples. The timeout sent SIGKILL 1001.3–1001.5 ms after spawn. These results support prompt termination on this development Mac; they do not establish a p95, every supported Mac's behavior, or containment of a hostile process that escapes its group.

The empty-group times are **upper bounds**: there is a 25 ms wait between `ps` scans, the scans themselves take time, and the final check follows build cleanup. Do not interpret the observed empty-group times as kernel kill latency. Peak sampled group RSS was about 155–157 MiB for TeX cancellation, 350–362 MiB with Biber, and 242–244 MiB for the longer TeX timeout. RSS sums can double-count shared pages and exclude Electron; these are observations, not an application memory-budget pass. No command arguments, unrelated process names or environment values are retained.

The final raw run is retained locally in `test-results/compiler-stop-0tp6oe/`, with source/script/runtime hashes in the published JSON. Earlier exploratory measurements are also retained locally. Compiler code and runtime inputs were unchanged; no optimization is claimed by this measurement.

## Save and history growth

The [storage measurements](performance/storage-baseline.json) use the production `ProjectStore` and `WorkspaceStore` on the same M4 Pro host. There are three separate profiles for each history length: 1, 25 and 100 versions. Each holds the real Classic A4 source (2,832 bytes) and its previously compiled PDF (23,366 bytes). Versions add different TeX comments and reuse that PDF, remain marked unverified, and test storage only. They do not exercise another compilation, renderer or AI request.

Reproduce after [generating a passing template comparison corpus](TEMPLATE_VISUAL_CHECKS.md):

```sh
node --import tsx scripts/profile-storage.mjs test-results/template-regression-<run-id> 3
```

The script checks fixture hashes, creates isolated app data, retains every measured stage and verifies exact source/PDF bytes and version counts after reopening. It records implementation/script hashes, Node CPU time, sampled RSS and 10 ms timer lateness. The measured implementation is based on `433a5c8`; the newly added profiling script is identified by its separate hash. These runs were separate from local native suites; concurrent GitHub qualification ran on a different machine. The initial exploratory run is retained locally in `storage-profile-9FlLDB`; the final recorded run is `storage-profile-CMVoOm`.

| Operation, observed range across three samples | 1 version | 25 versions | 100 versions |
| --- | --- | --- | --- |
| Append one checkpoint | 1.3–2.4 ms | 0.8–1.2 ms | 0.7–1.0 ms |
| Validate and compress history | 1.1–3.7 ms | 13.9–16.9 ms | 46.8–50.1 ms |
| Save project including history | 83.6–93.8 ms | 100.8–110.7 ms | 131.3–144.6 ms |
| Open saved project | 1.5–2.4 ms | 2.2–2.6 ms | 2.4–2.8 ms |
| Import its history into a new profile | 1.6–3.3 ms | 24.0–25.0 ms | 64.7–68.5 ms |
| Read and verify the latest version | 0.4–0.9 ms | Below 0.5 ms | Below 0.5 ms |

All nine cases preserve their source, PDF and complete history. Local workspace content grows from 27,017 to 672,419 to 2,689,499 bytes; the saved compressed history grows from about 24.9 KB to 614.6 KB to 2.46 MB. These are logical file bytes, not allocated filesystem space. The fixture is small and has no attachments or chat images; supported upper bounds still need measurement.

The 100-version archive stage observes 28.0–30.3 ms maximum timer lateness, and saving observes 25.4–29.7 ms. `WorkspaceStore.archive()` uses synchronous ZIP compression, and `ProjectStore.save()` calls it again for the saved history. This supports investigating compression away from the main process, but the measurement does not isolate compression from every other synchronous operation or establish renderer frame loss. Save and archive measurements overlap in work; they cannot be added or subtracted to estimate independent costs.

Peak sampled Node RSS across the run is 184.7 MiB. This includes allocations retained from prior cases, can miss short synchronous peaks, and excludes Electron and compiler children. OS caches were not purged. These observations establish neither a leak nor an application memory budget, and three samples do not establish p95. No optimization or storage-retention change was made for this measurement.

## Background history compression

The development implementation now validates history on the native side, compresses it in one bounded background worker, stores PDF bytes directly in the ZIP and compresses source/conversation JSON. It keeps every source/PDF check and the existing journaled save. Archives over the 100 MiB output bound retry the original full compression before rejection; the timing fixture is below that threshold. The [implementation notes](SAVE_RELIABILITY.md#background-history-compression) describe queue, worker, byte and deadline bounds.

The unchanged storage profiler ran three samples at each of 1, 25 and 100 versions on the same M4 Pro/48 GiB Mac. The [before record](performance/history-worker-before.json) is at `39c5973`; the [after record](performance/history-worker-after.json) retains all changed/new implementation hashes atop that source. Both use the exact same script and Classic A4 source/PDF fixture. No local native workflow, packaging or other Folio benchmark ran concurrently. OS caches were not purged; normal desktop work continued. Every save/reopen preserves exact source/PDF bytes and the complete version count.

| 100-version measurement, three samples per implementation | Before | After |
| --- | ---: | ---: |
| Median validation/archive time | 50.25 ms | 27.42 ms (45.4% lower) |
| Median complete project save, including history | 139.91 ms | 116.99 ms (16.4% lower) |
| Observed maximum timer lateness during archive, range | 28.34–37.36 ms | 1.71–2.17 ms |
| Observed maximum timer lateness during save, range | 28.84–30.08 ms | 1.39–2.41 ms |
| History ZIP bytes, range | 2,457,864–2,457,908 | 2,535,260–2,535,298 (about 3.1% larger) |

The first one-version archive takes 18.22 ms after the change versus 3.81 ms before, including cold worker startup. Later one-version archives take 0.81–0.93 ms versus 1.55–1.61 ms. This worker startup cost remains visible; it is not removed from the results. The initial all-deflated worker experiment reduced stalls but increased overall save time. Storing PDFs directly produced the final tradeoff above; raw exploratory runs remain in local test evidence.

Peak sampled Node RSS was 188.6 MiB before and 137.3 MiB after across each complete run. These are descriptive samples, not proof of lower worst-case memory, a leak fix or a full Electron budget. Node worker buffers and the foreground process share a process-level RSS reading. The fixture is about 2.7 MB of history, far below the 200 MiB input limit. Import inflation, history validation and outer source-ZIP compression still perform synchronous work; these results do not establish responsiveness of every workflow or archive size. Three samples are not a p95 or supported-device acceptance.

The below-10-ms timer-lateness target passes for this fixture, and median save time improves. Broader physical-device/UI, large-history and memory/retention targets remain open. See [the verification record](releases/history-worker-verification.json) for failure controls, package identities and native scope.

## Cost of recoverable history checkpoints

The newer [history storage policy](HISTORY_STORAGE.md) admits new snapshots only below 1,000 versions and 64 MiB of saved source/PDF bytes. Creation and explicit removal use a recovery journal. The original checkpoint path wrote three files without that journal; this change adds durability work and must not be described as a speed improvement.

Reproduce the matched measurement with a passing template corpus:

```sh
node --import tsx scripts/profile-history-storage.mjs <template-corpus-directory> 3
```

The [raw record](performance/history-storage.json) retains every latency, source hash and fixture identity. It compares the exact `e03cdfb` store against the current store on the same M4 Pro/48 GiB Mac. Only the baseline's relative import locations change; common dependencies and its shared runtime helper are checked against that commit. Each sample creates 100 distinct source-comment versions using the same real Classic A4 PDF, in a new isolated profile. Implementation order alternates between samples. Every archive's 100 source/PDF pairs and current storage total are independently checked after timing. No local compiler, native suite or packaging ran concurrently; OS caches were not purged.

| Measurement, three samples per implementation | Before | With quota and journal |
| --- | ---: | ---: |
| Median time to create 100 checkpoints | 80.22 ms | 9,690.90 ms |
| Median individual checkpoint in each sample | 0.74–0.79 ms | 96.07–97.09 ms |
| Checkpoint 100, range | 0.75–0.96 ms | 85.95–105.94 ms |
| Maximum observed 10 ms timer lateness, range | 0.72–2.58 ms | 2.14–2.93 ms |

Across each current 100-checkpoint run, journal commits account for 8.71–8.96 seconds and actual-file storage measurement accounts for 0.64–0.66 seconds. These stages are included in total checkpoint time. The approximately 0.10-second checkpoint cost buys recoverable source/PDF/index consistency; this backend measurement does not establish full input-to-PDF latency, power-loss durability or a reference-device budget. It also does not measure the maximum 1,000-version/64 MiB workload.

Keep the file flushes and recovery boundaries. Next investigate directory-flush batching inside unpublished journal preparation, then measure the largest admitted history and complete UI latency. Any optimization must preserve the process-kill controls, exact archive bytes, current-PDF protection and stale-save rejection. Actual-file size checks must not be replaced by unverified cached usage. Whole-profile and runtime/recovery-copy retention remain separate work.

## Process-tree resource baseline

The unchanged `349d6ce` package now has a native process-tree measurement across fresh preparation and three one-page/100-page build, navigation and export cycles. All nine PDFs verify. Across 421 snapshots, summed RSS peaks at 920.8 MiB and summed per-process footprint at 694.7 MiB at different times; neither is unique physical memory. CPU counters are calibrated against a real nested child workload and converted with the Mac's Mach timebase. The recorded workload contains 37.997 observed CPU-seconds over 82.038 seconds, with short-lived work potentially missed. Main/renderer memory and other Electron helpers need investigation alongside compiler use.

A fresh synthetic profile ends at 409.4 MiB of regular-file sizes, mostly its 378.5 MiB retained runtime. Memory decreases during the third repeated cycle, but this is not a long-session leak or retention guarantee. Provisional investigation thresholds and the next upper-bound/device experiments are in [the process resource report](PROCESS_RESOURCE_PROFILE.md), with [raw snapshots and independent verification](releases/process-profile-verification.json). The observer does not alter application code or impose whole-app quotas.

## Faster full runtime verification

Every build still verifies the selected compiler's entire locked inventory. Inspection found one full check in the warm build path, rather than a duplicate check that could be removed. The verifier previously read and hashed one complete resource at a time. It now overlaps up to four file readers and hashes 128 KiB chunks, using at most 512 KiB for their read buffers. It does not retain a whole resource or cache a prior verification result. Other objects and the application still use memory beyond these buffers.

Manifest identity, complete directory inventory, unexpected-file rejection, parent-folder checks, no-follow file opens, regular-file checks and every SHA-256 remain required. The 256 MiB individual-file and 1 GiB aggregate read limits still apply; a file that grows after its initial size check is rejected too. Failed verification stops assigning new files and waits for all in-flight readers to close before returning an error.

A matched development-host experiment uses production `verifyRuntime` and `Compiler` bundles from base `6de1274` and the changed source. Both bundles reproduce byte for byte from the retained source identities. Five pairs alternate AB, BA, AB, BA, AB on the same unchanged runtime. Each variant receives its own work directory and one real warmup compile. All twelve PDFs, including warmups, have identical extracted text and 100-DPI raster bytes. An independent reader also verifies all 3,982 runtime file hashes.

| Backend measurement, five samples per implementation | Before min / median / max | After min / median / max |
| --- | ---: | ---: |
| Full runtime verification | 668.1 / 676.3 / 680.3 ms | 356.0 / 368.3 / 369.7 ms |
| Complete warm one-page compile, including its own verification | 777.6 / 790.8 / 803.5 ms | 485.0 / 491.8 / 512.9 ms |

The candidate is faster in all five pairs. Median verification is 45.5% lower and median compilation is 37.8% lower for this synthetic fixture. The standalone verification and compile rows are separate operations; do not add them into one build time. The median compile reaches the fixture's 0.5-second investigation target, while the under-0.2-second verification target remains open. Neither result measures complete UI latency, first-time installation or a supported-device percentile.

Reproduce with retained baseline/candidate modules exporting `verifyRuntime` and `Compiler`:

```sh
node scripts/profile-runtime-verification.mjs /absolute/path/baseline.mjs /absolute/path/candidate.mjs /absolute/path/verified-runtime 5
```

The measured entry module exports those implementations from `electron/core/runtime.ts` and `electron/core/compiler.ts`; build each revision with the repository's pinned esbuild using `--bundle --platform=node --format=esm --packages=external`. Retain the modules, entry, metafiles and exact input hashes. The published summary records the exact before/after inputs and bundle hashes; raw observations retain PDF hashes and compile logs. This source experiment ran before the implementation commit, so the report's `sourceCommit` is the base and the candidate source hash identifies the change.

Five new controls cover bounded readers/buffers, complete hashing, same-size corruption with preserved timestamps, failure cleanup, resource growth and aggregate size admission. The allocation control rejects the original whole-file implementation. Existing corruption, pin, symlink, repair, resource-pack and migration controls also pass. These preserve per-build verification rather than introducing metadata-only or indefinitely cached trust.

OS caches were not purged. Both variants ran in one Node host; sampled host RSS cannot isolate their memory use and excludes native child processes. No other local Folio native test or benchmark ran during these ten samples. See [summary, source identities and PDF checks](performance/runtime-verification-summary.json), [raw observations](performance/runtime-verification-pairs.json.gz) and [verification](releases/runtime-verification-io-verification.json). Complete packaged-app and broader-device measurements remain separate gates.

## Prioritized changes

Workspace draft/history writes now admit at most four pending operations per project and eight across the store, including active writes. They release settled queue records rather than retaining a promise for every previously opened project. Excess requests fail visibly before storage work and can be retried; accepted changes retain their order. Regression controls and two packaged workflows verify the behavior in [the queue record](releases/workspace-queue-verification.json). This is an admission bound, not a measured speedup or a whole-app memory/disk budget. Active saved snapshots now have the separately measured 64 MiB admission policy and explicit older-version removal above. Whole-profile retention and the remaining queues/caches still need work.

Targets below are acceptance targets for experiments, not achieved results.

| Priority | Change to investigate | Why | Experiment target | Required protection |
| --- | --- | --- | --- | --- |
| 1 | Batch directory durability work within the unpublished runtime generation; first implementation achieves 36.1%, so the target remains open | About 31 s in verify/copy; nearly 4,000 directory syncs | At least 40% lower median preparation/copy time across five fresh profiles | Sync every required file and directory before publishing readiness; force-kill at every publication boundary; failed install preserves the previous compiler |
| 1 | Recovery, editing, saves and chat drafting now open before compiler preparation; extend the repeated package evidence to supported devices | Ten current-package launches accept chat drafts in 0.397–0.835 s; their first PDFs still take 4.25–56.24 s | Usable recovered project within the original plan's startup budget; progress remains visible until builds are ready | Load the real recovery project first; early close must preserve it; no compilation, export or AI apply may assume an unverified compiler |
| 2 | Bounded full-inventory hashing now lowers median backend verification by 45.5%; extend the matched result to the packaged UI and supported devices | The warm path has one full verification. Five pairs measure 368 ms median verification and 492 ms complete synthetic compilation after the change | Keep median changed-source compilation below 0.5 s for this fixture; verification below 0.2 s remains open | Rehash every file for every build; retain complete inventory, path, pin, size and failure-cleanup checks; avoid metadata-only or indefinitely cached trust |
| 2 | Investigate native startup/library-loading waits using the completed five-pair runtime comparison | Candidate is faster in four pairs but slower in one; sampled Biber CPU remains below 0.75 s while elapsed marker gaps reach 24.44 s | Explain the variation and demonstrate consistent improvement before changing the default runtime or first-PDF claim | Keep the offline bibliography self-test, exact pins, PDF comparisons, sandbox and integrity checks; sampled CPU and short stack windows do not establish the complete cause |
| 3 | Evaluate APFS clone/copy strategies and per-generation directory creation | Hundreds of megabytes and thousands of small files | Reduce I/O/metadata overhead without exceeding memory/disk budgets | Verify the resulting bytes and modes; retain independent versions through app replacement; handle non-APFS destinations explicitly |
| 3 | Consider packaging the bibliography helper's cache differently | It is 3,979 files and about 236 MiB | Smaller installation work and measurable startup/storage benefit | Preserve Biber compatibility, offline operation, read-only dependencies, complete licenses and exact runtime identity |
| 3 | Background compression passes the small-history timer target; measure the new quota/journal at maximum admitted history and extend whole-profile retention | With 100 small versions, history compression takes 46.8–50.1 ms and observed Node timer lateness reaches 30.3 ms; save rearchives history | Below 10 ms observed main-process timer lateness during a repeat of this fixture, with no material save-time regression | Retain exact version/source/PDF validation, immutable export snapshots, complete history round-trip and journaled save recovery; establish worker memory/cancellation limits |

Avoid treating the 700 ms source-edit debounce as compiler execution time. Measure user-perceived edit-to-PDF latency separately from the build phases. Removing that debounce may increase unnecessary builds and cancellation work.

## Measurements still needed for the complete app report

1. The ten current-package launches above now include buffered Chromium paint entries, verified draft input and close/reopen preservation. Add event-level recovery/compile/render timing and physical-display observations; extend the fixtures, sample count and supported-device coverage, retaining failures.
2. The sixty warm edit-to-preview samples above now separate the visible debounce, compiler duration, other native handling and completed rendering. Break down the native self-test/build interval further into snapshot creation, runtime verification, TeX, Biber and PDF reading. Extend worker loading, first visible page and export readiness measurements to multi-file, bibliography and 100-page fixtures and cold caches.
3. Measure AI edit requests, input-page rendering, candidate compilation, candidate-page rendering/review, retry and apply separately. Keep local protocol fixtures distinct from real-provider network latency.
4. Extend the nine backend save/history cases above to autosave, Save As, source ZIP import/export, recovery and supported upper bounds, including larger PDFs/assets/chat images. Record actual UI responsiveness while checksums/inflation/history work runs.
5. Extend the calibrated process-tree baseline above to upper-bound PDFs/images/history, longer sessions and additional devices. Measure on-disk cache/history growth and validate the provisional investigation thresholds before setting release-wide budgets. Extend the compiler-group cancellation/timeout observations above to end-to-end user actions, supported devices and more samples. The existing canvas budget is only one part of application memory.
6. Repeat on the chosen minimum/current macOS versions and reference Apple silicon machines, including physical high-DPI and clean offline installation. Report sample counts and spreads; do not present three runs as a reliable p95 estimate.

## Verification after an optimization

Keep before/after raw records tied to source and artifact hashes. Run the relevant process-kill, corruption, stale-result and native workflow tests before interpreting a speedup as a successful improvement. Compare the same fixtures, profile/cache states and runtime inputs. An optimization that shortens a check by weakening it does not satisfy the product's integrity requirements.

The full documentation/public-release goal remains open; this baseline is the first measured part of the requested performance investigation.

## Signing and the duplicate Biber archive

The private ad-hoc signing candidate replaces Biber’s self-extracting launcher with a small native entrypoint that uses the already expanded, verified Perl files. Its measured app regular-file total is 618,910,787 bytes, compared with 679,309,937 bytes in the preceding history package, a difference of 60,399,150 bytes. Both packages contain the same 39 application build outputs and the same ASAR hash. This is an artifact-size observation, not a startup-speed, unique disk-allocation or production-installer claim. Signing also changes library bytes and app metadata. See [Mac signing](MAC_SIGNING.md) for the verified build/render checks and [exact artifact evidence](releases/runtime-signing-verification.json).

Before setting a startup target for the production signed build, measure repeated cold preparation and warm startup on the supported Macs using the final Developer ID artifact. Keep existing runtime-copy, journal and whole-profile measurements separate; this size reduction does not establish those performance budgets.

## Reusing app downloads after signed feed renewal

The deterministic Electron updater fixture reproduced a repeated-transfer problem in the pinned updater: changing a signed manifest's publication time while retaining the same version and ZIP made its in-memory cache comparison reject reusable bytes. With the test transport offline, renewal made another ZIP request and failed. Starting a fresh on-disk cache helper keeps the matching updater path, rechecks SHA-512 and reuses the same ZIP without another request. The final fixture covers both an identical snapshot and a renewed signed snapshot.

This is a request-count control with an inert 256 KiB payload and an Electron protocol handler, not a public-network latency measurement or a production signed installation. Cached files are still read and hashed; no main-thread or wall-clock speedup is claimed. The new download/staging headroom formula is a conservative admission policy, not measured peak usage. Measure actual signed Squirrel cache/temporary/replacement peaks and shared/separate APFS volumes before treating it as a complete release disk budget. See [storage policy](APP_UPDATES.md#disk-space-and-cached-downloads) and [exact evidence](releases/update-storage-verification.json).

## Compiler storage admission and review

The [compiler storage policy](COMPILER_STORAGE.md) adds a bounded metadata scan before staging another compiler copy, and a Settings review for old identities. It deliberately measures logical lengths rather than APFS allocated blocks. The 16 GiB admission budget, 256 MiB preparation allowance and 1 GiB free-space margin are initial policy choices, not measured release peaks or speed improvements.

The native runtime fixture records time until the storage rows appear and byte totals before/after removal. A single workflow observation, especially with concurrent tests, does not establish a latency budget or population percentile. Next measure repeated metadata scans with many retained compiler identities, fresh/prepared OS caches and supported Mac storage; compare main-thread responsiveness before considering a verified inventory cache. Preserve stale-review and file-identity checks if caching is introduced. Whole-profile disk growth and real full-volume recovery remain open.

## Compiler work after an application crash

A process-kill diagnostic found a real bibliography compiler group still present 500 ms after its owning Node process died. The diagnostic explicitly stopped that owned group. Two separate kills during source staging left 262,318 bytes of synthetic source in temporary build folders; a later successful build did not remove those older folders. These observations are bounded backend checks, not a complete Electron crash or power-loss simulation.

The development compiler now connects an idle group watcher to a private parent pipe. Abrupt parent death closes that pipe independently of JavaScript cleanup; the watcher stops its own group. Regression controls exercise parent death, successful leader exit with a leftover helper, cancellation and timeout. See [compiler crash containment](COMPILER_RESOURCE_LIMITS.md#if-the-app-crashes).

New builds now use a private ownership record outside the compiler-writable snapshot. Startup scans recognized jobs, retains any live or uncertain process owner, and resumes interrupted removal after a crash. Twenty-one focused controls include real killed staging/cleanup processes, outside-file preservation, malformed records, allocation failure and an actual sandbox write check. The original Compiler fails the new startup-recovery control. See [build recovery](BUILD_RECOVERY.md).

The packaged-app crash gate now exercises actual Electron main-process death during a real UI compile, followed by draft/history recovery, cleanup and a new PDF export. The prior packaged app fails startup cleanup; the recovery app passes locally. The final local observation finds the native process group absent about 53 ms after SIGKILL, which is one observation rather than a percentile or supported-device bound. The test also found that a recently changed Auto-compile preference can reset after a crash. The current native preference change separately restores saved values before the workspace opens, coalesces renderer updates to one active write and at most five pending values, and waits on settings saves during ordinary close/restart. Fifteen focused controls and actual packaged crash/migration/error-retry workflows pass; this is a correctness change, without a startup-speed or physical power-loss claim. See [native preference evidence](releases/workspace-preferences-verification.json). See [exact evidence](releases/packaged-build-crash-verification.json).

Next measure cleanup time and responsiveness with large snapshots and many abandoned jobs on supported Macs. Older unmarked folders and unrecognized data require separate review; the new ownership format does not justify deleting them. Engine-cache retention, historical versions, aggregate disk/memory/CPU limits and whole-app supported-device acceptance remain open. Measure the additional watcher and cleanup scan as part of those process-tree budgets.
