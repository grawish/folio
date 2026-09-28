# Keep the newest build request

When you edit again during a build, Folio keeps the newest version waiting. It cancels older waiting requests instead of making them wait in a long line. The active build still finishes its cleanup before the next one starts. Your source is not deleted.

This behavior applies to the development source. It is not included in the published preview 4 installer.

## What the app keeps

| Work | Bound and behavior |
| --- | --- |
| Editor build, including disk review, asset reading, compilation and history | One active request and one newest waiting request. Replaced waiting requests immediately return a cancelled result with their own project and revision. |
| Each compiler instance | One active operation and one newest waiting operation. Active workspace and runtime-lease cleanup finishes before the next operation begins. |
| Repeated edits during compiler cancellation | Share the pending stop operation. They do not each attach another waiter to active compiler cleanup. |

A new edit asks the native compiler to stop immediately. A stale disk review, asset read or completed compiler result cannot start the next stage. If a request becomes stale during an already-started history write, that write finishes, but the old PDF is not returned as the newest result. Stop also drops the waiting request and waits for active disk/history work to finish.

Compiler removal and history removal treat the whole editor build as busy, including disk review before the native compiler starts. Save recovery, font setup, resource-pack operations, compiler comparison, app close and update restart use the same cancellation coordinator where they stop editor builds.

## Implementation

`electron/core/latest-work-queue.ts` owns active and pending slots. A failed active operation cannot break the next request. `electron/core/compiler.ts` uses it around native execution and cleanup. `electron/core/build-requests.ts` bounds the full editor pipeline; `electron/main.ts` supplies the real disk, compiler and history services through validated IPC.

Generation checks run between asynchronous stages and after cleanup. The current-source fingerprint, runtime verification, immutable snapshots, native limits and offline sandbox remain in use.

## Reproduce the checks

```sh
npm run typecheck
node --import tsx --test tests/latest-work-queue.test.ts tests/build-requests.test.ts tests/compiler-queue.test.ts
npm run test:integration
node scripts/check-compiler-request-backlog.mjs
# Use an Apple silicon Mac, an isolated packaged app, and Python with pypdf:
FOLIO_PYTHON=/path/to/python node scripts/test-build-requests.mjs /path/to/Folio.app/Contents/MacOS/Folio
```

The sixteen focused tests hold runtime acquisition, runtime release, disk review, asset reading or history writing while newer requests arrive. Bursts of 10,000 waiting requests leave only the active and newest requests unsettled. Tests also check Stop, failure recovery and exact cancelled revision identities. A real sandboxed compiler integration requires that only the newest of 1,000 waiting editor requests reads assets, creates a PDF and reaches the checkpoint callback.

A controlled before/after experiment holds the first runtime acquisition and sends 5,000 newer requests. The [original implementation](performance/build-request-backlog-before.json) leaves all **5,001** unsettled. The [bounded implementation](performance/build-request-backlog-after.json) settles **4,999** obsolete requests while the first remains held, leaving **two** unsettled. Both later acquire and release two runtime leases. Their final runtime-unavailable result is intentional synthetic input; the separate native integration exercises a real compiler.

The packaged fixture uses the real preload, IPC, project registration, disk review, compiler and history. It delays one `lstat` on its synthetic project directory to make the queue visible. It requires 499 of 501 requests to settle while the first is held, one newest PDF/history entry, independent PDF text parsing, and Stop/removal protection during disk review. The delay is a test instrument, not an application hook. The fixture passes against the new local package and fails against the previous qualified app with zero obsolete requests settled. Packaged workspace/autosave and chat/PDF workflows also pass. Full hosted qualification at `1d9a712` passes all 19 native suites, 427 source tests, 18 compiler integrations and twelve unchanged template images. The retained 161-file artifact, exact source/package/runtime identities and both queued-build and crash-recovery PDFs were independently verified; see [hosted evidence](releases/mac-bounded-build-hosted.json). See [verification and current package scope](releases/build-requests-verification.json).

## Limits

This is a request-count bound. The single-run timing and Node heap readings in the raw diagnostic are not a speedup claim, retained-heap measurement, Electron process-tree measurement or release resource budget. Pending IPC messages outside the coordinator, whole-profile cache/storage growth and total app CPU/memory require separate controls and measurements. Broader Mac acceptance and production signing remain in [the release audit](RELEASE_GAP_AUDIT.md).

Project recovery has a separate [bounded-write implementation and verification](RECOVERY_WRITES.md).
