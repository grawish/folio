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

1. Record Electron launch, recovery load, composer enabled, compiler ready and first PDF painted on fresh and prepared profiles. Include at least five runs per state and retain failures.
2. Break native self-test/build work into snapshot creation, runtime verification, TeX, Biber, PDF reading, worker loading, first visible page and export readiness. Use small, multi-file, bibliography and 100-page fixtures.
3. Measure AI edit requests, input-page rendering, candidate compilation, candidate-page rendering/review, retry and apply separately. Keep local protocol fixtures distinct from real-provider network latency.
4. Measure save, autosave, Save As, source/history ZIP export and import/recovery at normal and supported upper bounds. Record UI responsiveness while checksums/inflation/history work runs.
5. Measure peak memory and CPU for the entire Electron/compiler process tree, on-disk cache/history growth and cancellation/timeout stop latency. The existing canvas budget is only one part of application memory.
6. Repeat on the chosen minimum/current macOS versions and reference Apple silicon machines, including physical high-DPI and clean offline installation. Report sample counts and spreads; do not present three runs as a reliable p95 estimate.

## Verification after an optimization

Keep before/after raw records tied to source and artifact hashes. Run the relevant process-kill, corruption, stale-result and native workflow tests before interpreting a speedup as a successful improvement. Compare the same fixtures, profile/cache states and runtime inputs. An optimization that shortens a check by weakening it does not satisfy the product's integrity requirements.

The full documentation/public-release goal remains open; this baseline is the first measured part of the requested performance investigation.
