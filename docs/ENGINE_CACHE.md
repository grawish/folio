# Keep compiler helper files within a limit

Folio saves helper files so later PDF builds can start faster. It now keeps the two most recently used compiler caches in each compiler context. Old helper files are removed automatically and can be made again when needed. This development-source change is newer than the preview-4 download.

## If a build reaches the cache limit

Keep your current source open. Read the build message, simplify the document if it repeatedly creates large helper files, and click **Compile** again. Folio keeps the last successful PDF visible while the current source needs another build. An oversized cache is cleared after its writer stops, so a later build can start with a fresh cache.

A rebuilt cache can make that first retry slower. Ordinary warm builds reuse the existing format bytes. If a message says that a cache folder changed or contains linked or special files, keep that message for troubleshooting instead of deleting project files.

## Retention and active builds

| Limit | Scope |
| --- | --- |
| Two runtime identities | Per compiler work root, after cache admission and release. The selected runtime stays warm when it is within the size/count limits. |
| 128 MiB of regular-file bytes | Total retained recognized caches per work root after cleanup. This is logical file size, not filesystem allocation. |
| 4,096 descendant entries | Total retained files and directories across recognized caches per work root. |
| Eight nested directory levels | A deeper cache is rejected and cleared once the writer stops. |
| 500 ms scan interval | One non-overlapping scan of the active cache; excess growth stops the native process group. A final check runs before a build result is accepted. |

Editor, agent, migration and runtime self-test compilers have separate work roots. The process-wide admission guard rejects overlapping leases on the same canonical root without accumulating a waiting queue. Folio's normal single-instance profile is required; this in-process guard is not a lock for independent external programs.

Retention scans only hash-named runtime directories in the app's existing `engine-cache` namespace. It preserves unmarked sibling data. Linked roots, linked runtime directories, hard-linked or special payload files, and changed directory identities fail closed. Cleanup rechecks root and cache identities, runs after the native writer stops, and does not traverse link targets. Damaged or unrecognized storage is retained for review rather than counted as successfully cleaned.

`electron/core/engine-cache.ts` owns admission, usage checks and oldest-first eviction. `electron/core/compiler.ts` acquires a lease before staging native work, monitors active growth, checks it again after process exit, and releases it during success, failure or cancellation. Runtime selection, immutable project snapshots and offline compiler isolation remain in use.

The active cache can grow between observations, and an older idle cache can coexist with it until final cleanup. These are retained-storage bounds and a sampled growth guard, not an operating-system disk quota or a whole-app memory/CPU budget. App-wide backups, managed runtime copies and unknown legacy data require separate retention policies.

## Verification

```sh
node --import tsx --test tests/engine-cache.test.ts
node --import tsx --test tests/integration/engine-cache.test.ts
node scripts/check-engine-cache-retention.mjs
node scripts/test-engine-cache.mjs /path/to/Folio.app/Contents/MacOS/Folio
```

Ten focused controls cover warm reuse, oldest-first retention, aggregate byte/entry limits, active leases, oversized-cache replacement, depth, links, directory replacement and failed admission without new folders. A separate native-process test writes actual data beyond a small test budget; the process group is stopped and its cache is reclaimed.

A controlled lifecycle diagnostic gives the real Compiler five synthetic runtime identities and substitutes only a 256-byte native cache writer. The [earlier implementation](performance/engine-cache-retention-before.json) retains all five directories; the [new implementation](performance/engine-cache-retention-after.json) retains two. This checks retention without claiming a speedup or a memory reduction. The final synthetic compiler error is intentional; real offline compiler integrations test actual TeX output.

The packaged demo uses actual editing, compiler execution, warm format files and close/reopen. Its oversized-cache UI case changes one scoped file-size observation in its isolated profile; it does not fill a real disk. See [the verification record](releases/engine-cache-verification.json) for final results, exact inputs and retained failures. After integrating the separately qualified recovery-write change, all 452 source tests and both packaged workflows pass on the [combined package](releases/engine-cache-combined-verification.json). Its JavaScript source replay, original publisher checks and 39-demo desktop/mobile website also pass. Full [hosted qualification](releases/mac-engine-cache-hosted.json) at `05f58fe` now passes all 452 source tests, 19 compiler integrations, twelve unchanged template images and all twenty-one native suites. All 169 downloaded evidence files, exact source/package/runtime identities, JavaScript replay and original publisher materials were independently checked. Broader supported-Mac acceptance remains required.

## Measured check cost

On the development M4 Pro, five ordinary-format checks take 0.158–0.249 ms each. A deliberately full 4,096-folder cache takes 246–264 ms per check, so a large number of folders deserves further investigation even when their byte size is small. These are isolated metadata costs, not full-app latency or an OS resource guarantee. See the [measurements, limits and next steps](PERFORMANCE_IMPROVEMENT_PLAN.md#measured-cost-of-cache-checks).
