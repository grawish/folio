# Performance investigation and improvement plan

Measured 26 September 2026. The largest measured delays are first-time runtime preparation and repeated runtime verification. This report contains a real backend baseline and a prioritized plan. It does not claim that every app workflow or the plan's reference-device budgets have passed.

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

### Resource observations

Sampled Node-host peak RSS is 342.8, 423.4 and 457.0 MiB. This includes instrumentation and retained allocations across samples, excludes native child-process memory and does not establish an application leak or memory-budget pass. Host CPU totals also exclude compiler children. Physical high-DPI rendering, whole-app CPU/memory and process-tree termination measurements remain required.

## Actual packaged app startup

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

### Current guided-recovery package: five launch pairs

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

## Prioritized changes

Targets below are acceptance targets for experiments, not achieved results.

| Priority | Change to investigate | Why | Experiment target | Required protection |
| --- | --- | --- | --- | --- |
| 1 | Batch directory durability work within the unpublished runtime generation; avoid repeatedly syncing the same parent after every file | About 31 s in verify/copy; nearly 4,000 directory syncs | At least 40% lower median preparation/copy time across five fresh profiles | Sync every required file and directory before publishing readiness; force-kill at every publication boundary; failed install preserves the previous compiler |
| 1 | Let recovery and editing become usable while first-time compiler preparation continues | Main bootstrap currently waits for preparation; an included compiler should not keep all project controls inert for tens of seconds | Usable recovered project within the original plan's startup budget; progress remains visible until builds are ready | Load the real recovery project first; early close must preserve it; no compilation, export or AI apply may assume an unverified compiler |
| 2 | Eliminate duplicate verification within one tightly scoped operation/verified lease, and assess safe reuse between requests | About 0.70–0.85 s of each small warm build precedes native execution | Median changed-source warm build below 0.5 s for this fixture, with runtime-acquire work below 0.2 s | No global forever-valid cache; changed/corrupt files, replacement paths and compiler pins must still fail before execution; mutation/replacement tests must defeat stale reuse |
| 2 | Profile the self-test's TeX/Biber subprocess stages and first-execution behavior | Probe varies from 8.7 to 24.9 s | Attribute the variance first; target stable fresh preparation without first-user bibliography timeouts | Keep an actual offline bibliography self-test, immutable runtime files, restricted native execution and bounded timeouts |
| 3 | Evaluate APFS clone/copy strategies and per-generation directory creation | Hundreds of megabytes and thousands of small files | Reduce I/O/metadata overhead without exceeding memory/disk budgets | Verify the resulting bytes and modes; retain independent versions through app replacement; handle non-APFS destinations explicitly |
| 3 | Consider packaging the bibliography helper's cache differently | It is 3,979 files and about 236 MiB | Smaller installation work and measurable startup/storage benefit | Preserve Biber compatibility, offline operation, read-only dependencies, complete licenses and exact runtime identity |

Avoid treating the 700 ms source-edit debounce as compiler execution time. Measure user-perceived edit-to-PDF latency separately from the build phases. Removing that debounce may increase unnecessary builds and cancellation work.

## Measurements still needed for the complete app report

1. Add event-level recovery/compile/render timing and an actual first-paint marker to the five current-package launch pairs above. Expand sample count/device coverage for statistical performance claims, retaining failures.
2. Break native self-test/build work into snapshot creation, runtime verification, TeX, Biber, PDF reading, worker loading, first visible page and export readiness. Use small, multi-file, bibliography and 100-page fixtures.
3. Measure AI edit requests, input-page rendering, candidate compilation, candidate-page rendering/review, retry and apply separately. Keep local protocol fixtures distinct from real-provider network latency.
4. Measure save, autosave, Save As, source/history ZIP export and import/recovery at normal and supported upper bounds. Record UI responsiveness while checksums/inflation/history work runs.
5. Measure peak memory and CPU for the entire Electron/compiler process tree and on-disk cache/history growth. Extend the compiler-group cancellation/timeout observations above to end-to-end user actions, supported devices and more samples. The existing canvas budget is only one part of application memory.
6. Repeat on the chosen minimum/current macOS versions and reference Apple silicon machines, including physical high-DPI and clean offline installation. Report sample counts and spreads; do not present three runs as a reliable p95 estimate.

## Verification after an optimization

Keep before/after raw records tied to source and artifact hashes. Run the relevant process-kill, corruption, stale-result and native workflow tests before interpreting a speedup as a successful improvement. Compare the same fixtures, profile/cache states and runtime inputs. An optimization that shortens a check by weakening it does not satisfy the product's integrity requirements.

The full documentation/public-release goal remains open; this baseline is the first measured part of the requested performance investigation.
