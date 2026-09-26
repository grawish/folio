# LaTeX harness performance and validation

The narrow text-edit path now uses **one model call, one candidate compile and no image renders** when a matching PDF baseline exists. Layout requests and attached PDF notes retain every-page visual review. Unknown cases, changed pagination, overflow warnings and substantial source changes use the visual path.

## Controlled before/after measurements

[Before](performance/agent-before.json) and [after](performance/agent-after.json) retain five samples each, stage timings, call counts, Node version and source hashes. The baseline used the agent at commit `2390602bac9041ff31fa02e0478336e24fa9e508`; the updated source was measured from this working tree. These are local protocol fixtures, **not live-provider or actual compiler/render timings**.

The fixture replaces one word in a small TeX document. It supplies a current PDF baseline, fixed setup delay of 10 ms, 50 ms per model call, 20 ms per compile or image render, and 1 ms per metadata inspection. It still executes the real agent, patch validation and filesystem History checkpoints. Both runs use the same workload and delays. Median observations:

| Phase | Before | After |
| --- | ---: | ---: |
| Provider setup | 11.1 ms | 12.1 ms |
| Edit inference | 51.1 ms | 52.2 ms |
| Compilation | 21.1 ms | 22.1 ms |
| Image rendering | 42.3 ms | 0.0 ms |
| PDF metadata | 0.0 ms | 2.6 ms |
| Visual review | 51.1 ms | 0.0 ms |
| Total | 181.9 ms | 93.3 ms |

The median fixture total fell by 48.7%. This demonstrates the removed work under controlled delays; it does not predict a percentage speedup against a live account. Before: two model calls, one compile, two renders. After: one model call, one compile, two metadata inspections, zero renders. The first-run cost of obtaining a baseline is excluded.

Reproduce the updated measurement:

```sh
node --import tsx scripts/profile-agent.mjs docs/performance/agent-after.json
```

The native chat suite separately confirmed one Fast-model request with no input images, a real compiled two-page PDF, and an unverified (compile-only) History entry. Provider responses were supplied by a localhost fixture; no real account, API key or resume was used.

## Validation

- All 225 unit/protocol tests passed with localhost sockets available. The sandbox's blocked listening socket caused an unrelated pack-download fixture to abort on the initial run; it passed without code changes when localhost access was permitted.
- The focused agent/provider tests cover atomic and ambiguous patches, small versus structural changes, model roles, manual selection, missing catalogs, model-specific vision, effort mapping, captured credentials, warm Codex processes, cancellation and image-cache invalidation.
- Native chat passed model selection and restart persistence, PDF annotations, full visual review, real-PDF fast edits, compare/undo/restore, stale manual/outside edits, stop, errors, Save As, export and recovery.
- Native PDF lifecycle and workspace suites passed sequentially with isolated synthetic data, including PDF replacement, resizing, annotation anchoring, autosave, save failures and restart recovery.
- Typechecking, production build, formatting of changed code and whitespace checks passed.

Native evidence from this run is retained locally under `test-results/chat-exxuFL`, `test-results/pdf-lifecycle-eAS23K` and `test-results/workspace-dlpQDs`. The chat folder includes `chat-model-picker.png` showing the new controls and compile-only result.

## Limits

Auto stays inside the selected connection. A custom endpoint needs explicit Fast/Capable role choices to switch between models when discovery cannot supply useful defaults. Visual review requires an image-capable model. Existing snapshots lacking full source/asset/compiler provenance are rebuilt before reuse as a current baseline.

Narrow-edit checks are conservative heuristics, not a guarantee of visual correctness or factual accuracy. The user should inspect the finished resume. Live Codex, Claude Code and BYOK inference latency and account/model eligibility were not benchmarked. Initial compiler installation and overall application startup remain outside this change.
