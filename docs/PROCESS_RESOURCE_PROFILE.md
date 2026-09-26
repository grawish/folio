# Process memory and CPU measurements

The current development app was measured while preparing its compiler, building a short document, building a 100-page document, visiting distant pages and exporting PDFs. Three cycles finished successfully. This fills part of the resource-use investigation; it does not establish a maximum for every document or finish the production release.

## Recorded app and workload

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
