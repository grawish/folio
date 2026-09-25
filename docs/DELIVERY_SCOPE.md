# Implementation and community delivery

Updated 26 September 2026. This is an acceptance checklist, not a claim that the application or public release is complete. The active goal includes the Apple silicon implementation in `PROJECT_PLAN.md` and the additions below.

| Deliverable | Completion evidence required | Current state |
| --- | --- | --- |
| Working Apple silicon Mac app | Requirements mapped to current code, native workflow checks, exact app and installer verification, with remaining limits disclosed | In progress; see `RELEASE_GAP_AUDIT.md` |
| User documentation | Installation, first resume, every supported workflow, recovery, Settings, limits and troubleshooting verified against the final app | Existing feature notes; complete user guide pending |
| Developer documentation | Architecture, local build, tests, app/runtime boundaries, file formats, provider adapters, packaging and contribution workflow with reproducible commands | Partial |
| Demos and tutorials for every feature | Feature-to-tutorial matrix; synthetic sample projects; reproducible steps and actual captured outcomes; screenshots or recordings where useful | `FEATURE_GUIDE_INDEX.md` maps feature groups; first-resume and import-recovery tutorials written. Complete coverage and standalone recordings still pending. Concept mockups do not count as working demos |
| Reusable documentation skill | Discoverable SKILL.md, focused references, installation instructions, validated links and realistic usage checks | Pending; package alongside the documentation |
| New GitHub repository and release | Verified owner/name, public repository URL, source commit, release tag, downloadable arm64 artifacts/checksums and documentation matching that commit | Public [grawish/folio](https://github.com/grawish/folio) created on 26 September; CLI confirms `grawish`, ADMIN permission and empty repository. Source review/upload and release still pending. Do not use the connector's different `Dkm0315` account. No local Git repository exists yet |
| README and licenses | Accurate capabilities/limits, installation and screenshots, tutorial links, contribution instructions, application license and complete third-party redistribution materials | Pending. Current package metadata is UNLICENSED |
| Noncommercial community terms | Standard noncommercial license applied to original work; scope and third-party exceptions explicit; public description uses source-available terminology | Original source/docs now have unmodified PolyForm Noncommercial 1.0.0 in LICENSE, plus NOTICE and `LICENSING.md`; package metadata, public artifacts and complete dependency redistribution audit remain pending |
| Performance investigation and plan | Reproducible raw measurements of startup, runtime preparation/verification, compile, PDF display, AI phases, save/import/history and resource usage; stage-level bottleneck evidence; prioritized changes with targets and regression checks | Three backend samples and raw evidence complete in `PERFORMANCE_IMPROVEMENT_PLAN.md`; preparation/copy, self-test and runtime verification bottlenecks identified. Whole-app/AI/storage/device measurements remain open |

## Publication preparation

Use synthetic resumes and accounts in public examples, tutorials and demonstrations. Review the publishable tree for local account data, credentials, personal documents and machine-specific test artifacts. Keep ignored build caches and private test profiles out of the source repository. Publish the requested app artifacts through GitHub Releases rather than committing all historical build output. Preserve the licenses and required notices of Electron, fonts, TeX resources, Biber and other dependencies; the application's noncommercial terms cannot replace those licenses.

Do not claim a documented or demonstrated capability solely because it appears in the 24-screen visual concept set. Each feature entry should distinguish implemented, experimentally verified, account-dependent and planned behavior. Demos for account-dependent AI features must identify synthetic provider fixtures; do not present those as live subscription acceptance.

## License sources

The [Open Source Definition](https://opensource.org/osd), section 6, permits use in business and other fields. A ban on commercial use therefore requires different labeling. [PolyForm Noncommercial 1.0.0](https://polyformproject.org/licenses/noncommercial/1.0.0) is a standard software license that permits noncommercial use, modification and distribution under its terms. Check the complete text and compatibility of the shipped components before publication.

## Performance evidence standard

Measure on a recorded Apple silicon model, macOS version and app commit. Separate a fresh profile from subsequent launches; distinguish an empty compiler cache from a warm cache. Record sample count and spread, individual stages and end-to-end latency, CPU/memory/disk observations and failures. Do not subtract inconvenient runs or turn one startup observation into a p95 claim. Rank optimizations by measured user impact, correctness risk and validation cost. Keep source integrity, runtime verification, offline operation and PDF freshness intact while optimizing.
