# Compiler resource limits

Folio stops a document build if it takes too long or tries to write an oversized file. Your source stays available to edit, and the last successful PDF stays visible. Open **Build output** for the reason, simplify the document or reduce large images, then build again. An old PDF cannot be exported as the current document.

These limits apply to the current development source. The published preview 4 predates them.

## What is limited

| Resource | Limit | Scope |
| --- | --- | --- |
| Elapsed compiler time | 30 seconds for ordinary builds; 60 seconds for runtime self-tests | The application kills the compiler process group when the timer expires. Runtime preparation and input snapshot work happen before this timer. |
| CPU time | Same number of seconds as the elapsed-time limit | An inherited per-process macOS limit sends `SIGXCPU`. The signal is catchable, so this does not replace the elapsed-time stop. |
| Size of a file written by a compiler process | 128 MiB | macOS refuses writes beyond the per-file ceiling. This is not a total disk-usage limit. |
| Open file descriptors | 256 per process | macOS refuses additional descriptors. This is not a total process-tree limit. |
| Core dumps | Disabled | Both inherited core-file limits are zero. |
| Captured compiler log | 1,048,576 JavaScript string characters | The existing application log bound stops the process group and retains a truncated log. |

The OS limits are set before the existing macOS sandbox launches Tectonic. Biber and other permitted child processes inherit them. Both soft and hard values are set; if setup fails, the compiler is not launched. A signal or unsuccessful compiler exit also kills remaining members of its process group so a helper cannot keep the build's pipes open.

CPU-limit and oversized-file signals get specific messages in Build output. CPU-limit errors use the existing “This build took too long” advice. If a process handles a signal itself and reports a normal error, that original output remains available.

## Implementation

`electron/core/compiler-limits.ts` runs a fixed `/bin/bash --noprofile --norc` program. The executable and every argument travel as separate quoted positional parameters. Paths, TeX and user text are never interpolated into shell syntax. `Compiler.run` supplies its existing minimal environment, without shell startup variables. Bash file-size units are KiB in this invocation; native tests verify the resulting byte ceiling.

The wrapper preserves the existing offline sandbox, immutable source snapshot, cancellation, stale-result checks, runtime verification and build-folder cleanup. See [architecture](ARCHITECTURE.md) and [error help](BUILD_HELP.md).

[Apple's resource-limit manual](https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man2/setrlimit.2.html) describes inherited process limits and the CPU/file-size signals. Native controls are required as well: on the development Mac, a process that catches `SIGXCPU` continues running until Folio's elapsed-time stop kills it. Do not describe this as an unbypassable CPU quota.

## Verification and remaining work

`tests/compiler-limits.test.ts` checks all inherited values, failure before launch when a hard limit cannot be set, literal shell-metacharacter arguments, actual oversized writes, descriptor exhaustion, CPU-signal delivery, the elapsed-time stop after a caught CPU signal, and cleanup of a surviving helper. These tests use real macOS processes, not mocked OS calls. Other platforms skip the native controls.

The compiler integration suite exercises fresh offline template caches, imported packages/fonts/bibliography, isolation, cancellation, timeout and PDF freshness under the production launch path. Exact results and package checks are recorded in [the verification record](releases/compiler-limits-verification.json).

This change does not impose an application-wide memory budget, combined CPU quota, total disk budget or retained-history/cache limit. It also does not establish acceptance on every supported Mac or macOS version. Those requirements remain in [the release audit](RELEASE_GAP_AUDIT.md).
