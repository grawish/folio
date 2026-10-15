# Compiler resource limits

Folio stops a document build if it takes too long or tries to write an oversized file. Your source stays available to edit, and the last successful PDF stays visible. Open **Build output** for the reason, simplify the document or reduce large images, then build again. An old PDF cannot be exported as the current document.

These limits are included from preview 5. The older preview 4 predates them.

## What is limited

| Resource | Limit | Scope |
| --- | --- | --- |
| Elapsed compiler time | 30 seconds for ordinary builds; 60 seconds for runtime self-tests | The application kills the compiler process group when the timer expires. Runtime preparation and input snapshot work happen before this timer. |
| CPU time | Same number of seconds as the elapsed-time limit | An inherited per-process macOS limit sends `SIGXCPU`. The signal is catchable, so this does not replace the elapsed-time stop. |
| Size of a file written by a compiler process | 128 MiB | macOS refuses writes beyond the per-file ceiling. This is not a total disk-usage limit. |
| Open file descriptors | 256 per process | macOS refuses additional descriptors. This is not a total process-tree limit. |
| Core dumps | Disabled | Both inherited core-file limits are zero. |
| Captured compiler log | 1,048,576 JavaScript string characters | The existing application log bound stops the process group and retains a truncated log. |

The OS limits are set before the existing macOS sandbox launches Tectonic. Biber and other permitted child processes inherit them. Both soft and hard values are set; if setup fails, the compiler is not launched. Every compiler exit also stops remaining members of its process group so a helper cannot keep the build's pipes open, even after a successful build.

CPU-limit and oversized-file signals get specific messages in Build output. CPU-limit errors use the existing “This build took too long” advice. If a process handles a signal itself and reports a normal error, that original output remains available.

## If the app crashes

The development source gives each build an idle watcher connected to the app by a private pipe. macOS closes the pipe when the app exits, including an abrupt process kill. The watcher then stops its own compiler group, including helpers such as Biber. The native compiler closes its copy of the pipe before starting, so a helper cannot accidentally keep the app connection open.

On normal compiler exit, the app closes the same connection immediately. The watcher also stops leftover helpers after a successful result. It does not share the build's output pipes, and it stays in the group it can stop; no saved or guessed process ID is used after that group has disappeared. The ordinary cancellation, elapsed-time limit and macOS resource limits remain in place.

This adds one idle shell process and one parent pipe per active build. It is process-crash containment, not a whole-app resource budget. The development source also records ownership of new temporary build folders and removes recognized abandoned jobs when its compiler starts. Editing and saving can open while that scan runs; the next build waits for it. See [temporary build recovery](BUILD_RECOVERY.md) for preserved data and recovery limits.

## Implementation

`electron/core/compiler-limits.ts` runs a fixed `/bin/bash --noprofile --norc` program. The executable and every argument travel as separate quoted positional parameters. Paths, TeX and user text are never interpolated into shell syntax. `Compiler.run` supplies its existing minimal environment, without shell startup variables. Bash file-size units are KiB in this invocation; native tests verify the resulting byte ceiling.

The wrapper preserves the existing offline sandbox, immutable source snapshot, cancellation, stale-result checks, runtime verification and build-folder cleanup. See [architecture](ARCHITECTURE.md) and [error help](BUILD_HELP.md).

[Apple's resource-limit manual](https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man2/setrlimit.2.html) describes inherited process limits and the CPU/file-size signals. Native controls are required as well: on the development Mac, a process that catches `SIGXCPU` continues running until Folio's elapsed-time stop kills it. Do not describe this as an unbypassable CPU quota.

## Verification and remaining work

`tests/compiler-limits.test.ts` checks all inherited values, failure before launch when a hard limit cannot be set, literal shell-metacharacter arguments, actual oversized writes, descriptor exhaustion, CPU-signal delivery, the elapsed-time stop after a caught CPU signal, and cleanup of a surviving helper. These tests use real macOS processes, not mocked OS calls. Other platforms skip the native controls.

`tests/compiler-parent-death.test.ts` kills a real owning Node process three times and requires its compiler group and log-holding helper to disappear within two seconds. It also covers successful exits with a leftover helper, cancellation, elapsed timeout and exclusion of the parent pipe from the native executable. The parent-death control fails against the original launcher; failed controls explicitly stop their owned test processes. These are backend process tests, not a complete Electron crash or physical power-loss check. The [watchdog verification record](releases/compiler-parent-watch-verification.json) also records the real bibliography crash, all 371 source tests, 16 compiler integrations and both exact packaged runtime/chat workflows. Full hosted qualification at `909c0ee` passes all 371 source tests, 16 compiler integrations, twelve unchanged template images and all sixteen native suites. The [hosted evidence](releases/mac-compiler-parent-watch-hosted.json) independently checks all 146 downloaded files, exact source/package records, JavaScript replay and original dependency materials.

The compiler integration suite exercises fresh offline template caches, imported packages/fonts/bibliography, isolation, cancellation, timeout and PDF freshness under the production launch path. Exact results and package checks are recorded in [the verification record](releases/compiler-limits-verification.json).

`node --import tsx scripts/profile-compiler-stop.mjs 3` reuses the production resource-limited launcher to observe three cancellation/timeout samples for runaway TeX, bibliography and elapsed-time paths. On the 29 September 2026 M4 Pro development host, all nine samples sent the production group `SIGKILL`; process close took 2.1–6.2 ms and group absence took 69.6–222.5 ms, including 25 ms `ps` polling. The raw record is `test-results/compiler-stop-FugebL/result.json` (SHA-256 `008ffd326066a483afddaea932401b90fc5d91096ed4d271bb33d5d14223d597`). It proves the observed unsigned development runtime controls, not signed-runtime isolation, every Biber workflow, a hostile process escaping its group or a supported-device percentile.

Hosted qualification at `b80edb4` also passes on Apple silicon macOS 15.7.9: all 253 source tests, 15 compiler integrations, twelve zero-difference template comparisons, all fourteen native suites and final package verification. This includes the actual native resource-limit controls. The [hosted verification record](releases/mac-compiler-limits-verification.json) distinguishes downloaded evidence from runner-reported installer hashes. It does not establish the proposed macOS 14 minimum or every supported device.

This change does not impose an application-wide memory budget, combined CPU quota, total disk budget or retained-history/cache limit. It also does not establish acceptance on every supported Mac or macOS version. Those requirements remain in [the release audit](RELEASE_GAP_AUDIT.md).
