# Remaining work for Folio

Updated: 28 September 2026. This is the current remaining-work checklist for the Apple silicon Mac release and its documentation, website, performance report and community distribution. It records work still needed; it does not restart the paused implementation goal or claim a production release is ready.

Use this checklist for the next actions. Use [the release audit](RELEASE_GAP_AUDIT.md) for historical evidence and [the original plan](../PROJECT_PLAN.md) for requirements. Older reports describe their own commits; a newer passing check can close an old test failure without closing all release requirements.

## Scope that stays in place

- Apple silicon Macs only. Windows, Linux, Intel Macs, mobile and a browser-only app are outside this release.
- Chat is the main screen. The PDF is beside it; Code remains available as a secondary view.
- Users can mark the PDF and send those notes to their selected AI connection.
- AI provider setup and active-provider selection belong in Settings. Support installed Codex and Claude Code subscriptions, user API keys, and compatible endpoints.
- Templates, local compilation, preview and export must work offline without a separately installed development or TeX toolchain. Cloud AI still needs its provider connection.
- Original Folio work keeps the chosen noncommercial terms. Third-party components keep their own terms. Use the existing source-available description.
- Deliver the app, user/developer guides, feature tutorials and genuine screenshots, documentation Skill, GitHub release, themed website, and a measured performance plan.

## What is already available

This is the starting point, not more unfinished work:

| Area | Verified starting point | Limit of that evidence |
| --- | --- | --- |
| App and public download | Chat, PDF notes, local builds, templates, file/history recovery and an unsigned [preview-4 download](https://github.com/grawish/folio/releases/tag/v0.1.0-preview.4) exist. | The download predates newer source work and is not a signed production release. |
| Latest full hosted app check | Source `0bee271` passed 486 source tests, 19 compiler checks, 12 unchanged template images and 24 native app suites on macOS 14.8.9 and 27.0. All 178 evidence files per OS and both app inventories were independently checked. | Developer machines in CI do not prove clean consumer installation, physical accessibility, every supported OS version or the separate PDF-highlight workflow. See [OS qualification](MAC_OS_QUALIFICATION.md). |
| Editor changes | [PR #43](https://github.com/grawish/folio/pull/43), head `f234448`, is open and draft. Its latest source checks pass. | It still needs integration and publication. |
| Ordinary typing measurements | [PR #44](https://github.com/grawish/folio/pull/44), head `e21fd2a`, is open and draft. Latest source checks pass; the stronger follow-up passes two 120-cycle sessions. | It is based on PR #43. Memory still grows during the measured sessions. See the [report at its recorded commit](https://github.com/grawish/folio/blob/e21fd2a40eab5f27fe1ebe08cb49feabacd4cb97/docs/EDITOR_TYPING_PROFILE.md). |
| Documentation and website | Eleven walkthroughs and 40 screenshot demos are present on the lifecycle branch. Its local website checks pass. A documentation Skill exists. | The last recorded live gallery has 39 demos; publication of the new content and a final feature review remain open. The live site was not rechecked for this documentation-only update. |
| Real AI use | One real Claude subscription PDF-note/edit/build/review/save/export/reopen workflow passed. Codex has a real synthetic-image connection check. | These are limited account/model observations, not complete live-provider or signed-app acceptance. |

PR state was checked on 28 September 2026. Check the exact heads again before merging. No percentage-complete or finish-date estimate is implied.

## Suggested order

1. Finish and merge the already qualified editor work and typing report.
2. Fix the confirmed PDF-highlight timing bug; add the missing test and tutorial.
3. Work through resource limits, performance, licensing and broader functional checks.
4. Complete clean-Mac, physical accessibility/input and real-provider checks when those environments are available.
5. Qualify the final signed app and its real update path once signing credentials are available.
6. Publish matching app, source, notices, documentation, Skill and website artifacts.

Work in steps 1–3 and most documentation work does not depend on Apple signing credentials. Do not rerun a completed full test campaign solely to create more evidence; repeat affected checks after meaningful changes and qualify the exact final release candidate.

## 1. Integrate the work already prepared

- [x] **INT-01 — Finish PR #43.** Completed 28 September 2026. The description was updated with the verified macOS 14/27 results, preserved earlier failures, local website checks and the remaining PDF-highlight gap; the PR was marked ready and squash-merged as `2391f08` with source CI passing at head `bf2bd0e` and on main. The branch is preserved in its worktree. **Done when:** the intended changes are on main with passing required checks and a recorded merge commit.
- [x] **INT-02 — Finish PR #44.** Completed 28 September 2026. The branch was rebased onto main after #43 merged (dropping the squashed lifecycle commits), the title/description now present the failed initial protocol as failed and the atomic follow-up as the pass, and typecheck/build plus all 486 source tests passed on the rebased head `eef343f` before the squash merge `573433b`. **Done when:** main includes the profiler, independent reader, raw evidence and accurate report, without calling the original failed protocol a pass.
- [x] **INT-03 — Keep workspaces and evidence intact.** Completed 28 September 2026. The user's main checkout was only fetched/pulled; integration ran in the existing managed worktrees, and packages, raw failures and benchmark inputs are untouched. Current branch/merge state and the preserved evidence map are recorded in the lifecycle worktree's ignored `test-results/integration-handoff-current.json`, which supersedes the stale progress notes. **Done when:** current branch/run state is recorded and no evidence is mistaken for an active process or a newer app build.

## 2. Repair and fully check PDF change highlighting

This means the automatic marks showing what the AI changed. The existing tools for drawing notes on the PDF are a separate feature.

- [x] **PDF-01 — Fix the confirmed late-history-read bug.** Repaired 28 September 2026 on `fix/pdf-highlight-late-read`. `src/App.tsx` now keys the late before-PDF read on the applied project id and revision instead of `activeRun`, so a valid late reply completes while a project switch or newer build still discards it. The retained `0bee271` package record fails the delayed case (`pdf-highlight-Xt0uDy`); the repaired build passes both ordinary and delayed scenarios (`test-results/pdf-highlight-qJH9cp`, published in `releases/pdf-highlight-fix-verification.json`). **Done when:** the retained old package fails the delayed case and the repaired app passes it, plus ordinary comparison still works.
- [x] **PDF-02 — Supply the missing declared test.** Completed 28 September 2026. The prepared fixture is promoted to `scripts/test-pdf-highlight-smoke.mjs`; `npm run test:pdf-highlight` builds and runs it from the checkout, and both scenarios pass with retained evidence and the portable failure/fix record above. Final packaged-workflow qualification remains with REL-02. **Done when:** the documented command runs from a clean checkout and the final packaged workflow passes.
- [x] **PDF-03 — Check late and replaced results.** Completed for the locally reachable scope, 28 September 2026. `PdfPreview` now drops a comparison whose after-bytes differ from the displayed PDF, so old marks and their controls cannot appear over a replacement, manual rebuild, History restore or another project; `App.tsx` clears the comparison on project load and restore, and the identity guard discards late work for a stale project/build. The delayed smoke scenario exercises completion-after-settle ordering end to end. Cancellation/closing-while-pending remain covered only by the hook's abort-on-change/unmount path, not a dedicated native case. **Done when:** marks and navigation always belong to the intended displayed PDF, and late work is safely discarded when its project/build is no longer current.
- [x] **PDF-04 — Check pages added and removed.** Completed 28 September 2026. `PdfPreview.navigate` clamps to the displayed document's page count, and dedicated native cases now run in the ordinary smoke scenario (`scripts/test-pdf-highlight-smoke.mjs`, evidence `test-results/pdf-highlight-71aVz0`): a real AI removal leaves the structural removed marker on the last surviving page and it outlives the timed flash; a real AI insertion shows the inserted outline and label and clears the stale removed marker. Page numbers stay valid, all supported changes are reachable, and no obsolete regions are shown on another page.
- [x] **PDF-05 — Preserve correct rendering and export.** Completed for the locally reachable scope, 28 September 2026. The maintained smoke keeps the ordinary fixture's checks — normalized region placement, timed fade, replay, zoom stability, two-page Previous/Next navigation, saving, and highlight-free exported bytes equal to the saved version — and both scenarios pass on the repaired build. Worker cleanup relies on the comparison hook's abort/unmount path; no new leak was observed. **Done when:** actual exported bytes equal the selected saved PDF and comparison work does not leave active workers or stale UI after disposal.
- [x] **PDF-06 — Add the real walkthrough.** Completed 28 September 2026. The chat tutorial gains "See what the AI changed" with a real capture from the passing smoke run (`docs/images/pdf-change-highlights.png`, labeled scripted local AI fixture), the feature matrix and demo catalog gain matching entries, and the Skill reference mirrors the walkthrough. Reproduction: `npm run test:pdf-highlight`. **Done when:** the screenshot and instructions match the repaired app and their reproduction steps are retained.

Retained local evidence: `test-results/pdf-highlight-Xt0uDy/result.json` describes application source `0bee271`, with ASAR SHA-256 `7ab490486ba31a5a0b487231f7c176c756a22cff61869832c88bdd63373d99be`. The ordinary case passes; the delayed case fails after a 15-second wait for Show changes. The earlier `pdf-highlight-IBkHL3` run stopped at the app's valid save-confirmation dialog; that was a fixture mistake. Both records and exact fixture copies remain in the lifecycle worktree's ignored test-results directory. They are not published release evidence yet. Publish a reviewed, portable failure/fix record with the repair.

## 3. Finish performance and resource work

Some parts already improved. Background history compression and full runtime verification have measured improvements; the hidden editor now has passing behavior checks. These do not establish a complete memory, CPU or disk budget.

- [ ] **PERF-01 — Resolve the large-session CPU failures.** The retained 120-cycle large-document run has a build at 3.735 observed CPU-seconds against a 3-second investigation threshold, and an idle interval at 13.30% of one core against 10%. Find the causes, make justified changes, then repeat affected measurements with the same correctness checks. **Done when:** failures are explained and repaired or an explicit, evidence-based target decision is recorded; they are never silently removed from the report.
- [ ] **PERF-02 — Explain and bound long-session memory growth.** In the passing ordinary follow-up, Code idle RSS medians rise from about 629 to 763 MiB; Chat rises from about 588 to 767 MiB. Footprint also rises. Check real typing, repeated AI changes, long PDFs, project changes and long history under normal garbage collection. **Done when:** retained memory has an explained, tested bound for the chosen workloads and devices. Lower DOM counts or forced-GC results alone do not close this item.
- [ ] **PERF-03 — Retain the unexplained initial typing anomaly.** The earlier Code session recorded zero attached editor views at one idle endpoint. It lacked a simultaneous tab/panel record, so the cause is unknown. The stronger follow-up did not reproduce it. **Done when:** the limitation remains explicit; investigate further if it recurs. Do not claim the passing rerun explains the old event.
- [ ] **PERF-04 — Finish startup and compiler stage measurements.** Separate recovery readiness, first paint, snapshot copying, full runtime verification, TeX, Biber, PDF reading, rendering and export readiness. Explain the observed first-run/native-library wait variation. Existing experiment targets still include 40% lower preparation/copy time and verification below 0.2 seconds; prior results did not meet both. **Done when:** supported-device results and a prioritized next-step decision are published, with cold and warm runs separated.
- [ ] **PERF-05 — Measure the whole AI journey.** Time input-page rendering, provider response, edit validation, compilation, candidate rendering, visual review, retries and apply. Keep local scripted-provider timings separate from real network/provider timings. **Done when:** slow stages and user-visible waiting times have reproducible evidence and a ranked optimization plan.
- [ ] **PERF-06 — Measure storage and large inputs.** Cover maximum admitted history, PDFs, images, chat attachments, autosave, Save As, ZIP import/export, recovery, many compiler identities and low disk space. Record UI stalls and worker memory/cancellation as well as elapsed time. **Done when:** supported upper bounds stay responsive or fail with a safe, understandable recovery path.
- [ ] **PERF-07 — Complete whole-profile retention.** Audit recovery copies, saved/archived history, imported-pack archives, old runtime identities, temporary imports and abandoned builds. Existing history admission and compiler-cache bounds do not cover every retained byte. Preserve current/in-use data, user-owned files and unrecognized folders. **Done when:** each store has a documented limit, review/removal policy and tested interruption behavior; long-session disk growth is accounted for.
- [ ] **PERF-08 — Set and enforce release-wide budgets.** Establish memory, combined process CPU, total disk and queue/cache limits from representative Apple silicon measurements. Existing per-process limits, per-file size limits and PDF canvas budgets are not whole-app quotas. Complete the original hard compiler/OS memory and disk-limit work, or record an explicit reviewed support limitation. **Done when:** the final candidate meets the agreed limits and hostile/oversized workloads cannot bypass the claimed protections.
- [ ] **PERF-09 — Complete reference-device timing.** Extend startup, warm/cold build, cancellation and recovery checks to the supported OS/device matrix, with enough samples to justify any percentile claim. Keep raw failures and observer overhead. **Done when:** the final performance report states hardware, OS, exact app identity, workloads, sample counts, spread, remaining limits and optimization priorities.

Sources: [performance plan](PERFORMANCE_IMPROVEMENT_PLAN.md), [process measurements](PROCESS_RESOURCE_PROFILE.md), [compiler limits](COMPILER_RESOURCE_LIMITS.md), [history storage](HISTORY_STORAGE.md), [compiler storage](COMPILER_STORAGE.md), and the [ordinary typing report in PR #44](https://github.com/grawish/folio/blob/e21fd2a40eab5f27fe1ebe08cb49feabacd4cb97/docs/EDITOR_TYPING_PROFILE.md).

## 4. Complete Mac, accessibility and durability acceptance

- [ ] **MAC-01 — Finalize the supported OS/device list.** Decide and document the actual minimum macOS version and reference Apple silicon devices. macOS 14.8.9 testing does not prove 14.0, and old macOS 15 checks do not qualify every later app change. Arrange a maintained minimum-version test environment if a hosted runner disappears. **Done when:** every advertised target has suitable recorded evidence and a clear support policy.
- [ ] **MAC-02 — Test a clean consumer installation.** Use a standard account with no Node, Homebrew, TeX or pre-existing Folio caches. Install in the user's Applications folder, launch, and create/compile/preview/export every bundled template offline. Check relocation and paths with spaces. **Done when:** the exact final installer works without administrator access or hidden developer dependencies.
- [ ] **MAC-03 — Check the Git prerequisite on a clean Mac.** Git is currently external, and commit identity is configured separately. Verify the missing-Git and missing-identity guidance without assuming Xcode Command Line Tools are installed. **Done when:** the optional Git workflow works when its documented prerequisite is present and fails clearly when it is absent; the main resume workflow still works.
- [ ] **MAC-04 — Finish physical accessibility.** Use VoiceOver and keyboard-only journeys through Chat, Code, Git, files, PDF, notes, History, Settings and dialogs. Check focus order/return, names, status/error announcements, resized panes, themes and physical high-DPI screens. **Done when:** real users can complete supported tasks and recorded defects are resolved. Automated ARIA/keyboard checks are only part of the evidence.
- [ ] **MAC-05 — Test real text input.** Use physical input methods, composition, accented/non-Latin text, shortcuts and undo across views, files and reopen. Browser-injected composition checks do not prove physical IME behavior. **Done when:** entered characters, cursor/selection and saved source stay correct on the supported setups, with font limitations explained.
- [ ] **MAC-06 — Finish filesystem durability checks.** Exercise save, autosave, preference persistence, import, recovery and format migration on supported filesystems, including the promised network-filesystem scope. Test storage exhaustion and appropriate abrupt-loss cases. Process-kill tests do not prove physical power-loss durability. **Done when:** the recovery guarantees are supported by evidence or filesystem restrictions are stated explicitly.
- [ ] **MAC-07 — Broaden the supported document corpus.** Check imported templates, local fonts, bibliography, Unicode, diagnostics, archives and large projects on supported systems. Keep missing-resource/engine limitations understandable. **Done when:** the published compatibility corpus passes and unsupported cases have accurate guidance.

Sources: [OS qualification](MAC_OS_QUALIFICATION.md), [keyboard coverage](KEYBOARD_ACCESSIBILITY.md), [save reliability](SAVE_RELIABILITY.md), [ZIP import](ZIP_IMPORT.md), [templates](TEMPLATES.md), [Git guide](tutorials/git-history.md).

## 5. Finish real-provider and security checks

- [ ] **AI-01 — Complete real BYOK checks.** With authorized test accounts, exercise OpenAI, Anthropic and a documented compatible endpoint: connection test, image support, annotated edit, compile/review, save/export/reopen, errors and cancellation. Use synthetic resumes and retain no secrets. **Done when:** supported provider/model combinations have accurately scoped live results; protocol fixtures are still labeled synthetic.
- [ ] **AI-02 — Extend subscription acceptance.** Complete a real Codex edit/review workflow and broaden the existing single Claude workflow where support is advertised. Check expired/signed-out accounts, missing tools, unavailable image models and changed provider capabilities. Repeat key workflows against the signed release candidate. **Done when:** documentation states what was actually tested and all promised flows work through the installed official tools.
- [ ] **AI-03 — Reconcile selection documentation.** The README currently describes a model picker in Chat, while the chat-first specification says models are selected only in Settings. Inspect the current implementation and applicable user direction, then make docs, tests and screenshots agree. Keep provider configuration and active-provider selection in Settings as requested. **Done when:** the supported selection flow is unambiguous and no document claims controls that are absent or contradictory.
- [ ] **SEC-01 — Complete the application-boundary review.** Review typed IPC validation, authorized paths, renderer isolation/navigation, external links, secrets, provider processes and support/export privacy against the final app. Extend hostile TeX/PDF/archive checks where coverage is missing. **Done when:** the review and relevant native controls demonstrate the stated boundaries, including outside reads/writes, network, shell execution and runaway work.
- [ ] **SEC-02 — Validate signed compiler isolation.** Check the real signed Tectonic/Biber/helper layout, inherited limits and crash/cancel cleanup on supported macOS versions. Preserve verification of every runtime file; do not bypass checks for speed. **Done when:** the final signed runtime passes isolation, offline bibliography and process-tree termination checks.

Sources: [chat-first implementation](CHAT_FIRST_IMPLEMENTATION.md), [AI guide](tutorials/ai-connections.md), [architecture](ARCHITECTURE.md), [compiler limits](COMPILER_RESOURCE_LIMITS.md), [support bundles](SUPPORT_BUNDLES.md), [security policy](../SECURITY.md).

## 6. Complete managed-resource operations

The published table pack and normal-app catalog/download/preview/apply/restart path already have passing evidence. The older instruction to run the original fourteen-suite campaign is historical, not a missing first test.

- [ ] **PACK-01 — Qualify packs with the production-signed runtime.** Signing changes native bytes and therefore compiler identity. Publish/verify compatible signed-base manifests and pack targets; test offline import, normal HTTPS transfer, cancellation/resume, repair, comparison, Apply and restart against the exact release. **Done when:** the signed app accepts the intended pack and rejects mismatched/tampered inputs without damaging the old runtime.
- [ ] **PACK-02 — Finish publisher incident drills.** Exercise key rotation/retirement, catalog expiry, rollback/replay rejection, unavailable hosting and recovery from a lost or compromised publishing key. Keep private keys out of public artifacts. **Done when:** a documented operational drill preserves trust and a working recovery path.
- [ ] **PACK-03 — Finish large-pack and interruption checks.** Measure responsiveness, free-space checks, quotas and historical archive retention. Check interrupted writes and relevant power-loss behavior on supported Macs. **Done when:** partial installs cannot become active and users retain a valid compiler and understandable retry/cleanup choices.

Sources: [managed packs](MANAGED_PACKS.md), [runtime management](RUNTIME_MANAGEMENT.md), [compiler migration](COMPILER_MIGRATION.md), [compiler storage](COMPILER_STORAGE.md).

## 7. Complete third-party materials and the final component list

An SBOM is a list of the software components shipped in the app. An inventory or a matching source file is useful evidence, but it does not by itself finish the redistribution review. These tasks complete the existing licensing work; they do not change Folio's chosen license.

- [ ] **LIC-01 — Resolve the remaining Biber evidence gaps.** Exact source/generated-byte coverage is 3,805 of 3,932 payload files, leaving 127 gaps. Address the unmatched Unicode index, differing XSLoader outputs, native libraries/modules and their actual build inputs. Static source associations do not close exact-build gaps. **Done when:** every remaining entry has a reviewed source/build and redistribution disposition, with uncertainty retained where evidence is missing.
- [ ] **LIC-02 — Resolve native-library and optional-module uncertainties.** Review the unresolved libbtparse identity, unproven libssl patch version, six ambiguous Encode source associations and ten generated-XS modules. Determine the handling of optional X11/MySQL references with no bundled candidates. Verify actual loader behavior where needed; static path matches alone do not prove it. **Done when:** the final shipped set and its required materials are established and ordinary supported workflows need no undeclared libraries.
- [ ] **LIC-03 — Finish compiler/native linkage and source materials.** Complete Tectonic, Rust standard-library, linked/static/vendored native code and build-patch attribution. Separate shipped components from tools merely installed on the original build host. Complete Electron/Chromium, JavaScript and PDF.js source-related obligations beyond collected notice texts. **Done when:** the exact shipped components have the required originals, notices, build/source materials and traceable versions.
- [ ] **LIC-04 — Finish font and TeX grant review.** All 516 TeX resources now have direct or generated provenance, but review individual redistribution conditions, font grants and source requirements. Preserve original differing headers/catalog labels and the separately licensed replay tool. **Done when:** the required materials for the final bundle are assembled and their inclusion is checked.
- [ ] **LIC-05 — Publish the complete exact-artifact materials.** Produce the final signed-app SBOM, covering embedded archives, linked components and per-file/component mappings. Verify notices and required source packages inside or alongside the actual release as appropriate. **Done when:** app, DMG, ZIP, source archive and published third-party materials agree; any incomplete coverage is still labeled incomplete. Do not represent the current partial CycloneDX inventory as a finished audit.

Sources: [licensing](LICENSING.md), [third-party notices](../THIRD_PARTY_NOTICES.md), [compiler provenance](COMPILER_PROVENANCE.md), [physical app inventory](MAC_APP_INVENTORY.md), [Biber notices](BIBER_NOTICES.md).

## 8. Finish signing, installation and real updates

Apple signing/notarization credentials are unavailable. The implementation can be prepared and reviewed, but production signing and genuine signed-update acceptance remain blocked on those credentials. No credentials are requested by this document.

- [ ] **REL-01 — Build and notarize the production candidate.** Use the owner's actual Developer ID and expected Team ID, hardened runtime and secure timestamps. Sign native runtime files before recording their fingerprints, run the offline self-test, seal/notarize/staple the app, and finish the DMG's separate notarization/stapling step. **Done when:** production verification passes for the exact app, DMG and ZIP, including Apple checks. Private ad-hoc signing does not count.
- [ ] **REL-02 — Qualify the exact final bytes.** Run the required source/compiler/template/native checks, including the new PDF-highlight suite, on the selected final source and supported release environments. Verify complete physical inventories, archive contents, notices and evidence digests. Generate checksums after all signing/notarization changes. **Done when:** the downloadable files are the same files that passed production acceptance.
- [ ] **REL-03 — Enroll the update publisher.** Configure the real Team ID, authenticated metadata key and Stable/Beta trust settings in the signed base app. Arrange protected signing-key storage and feed renewal before expiry; automatic app-feed renewal is not currently implemented. **Done when:** a documented, tested publishing/renewal process keeps both channels valid without weakening signature or rollback checks.
- [ ] **REL-04 — Test a real signed-to-signed upgrade.** Start from a signed base app, download authenticated metadata/ZIP, preserve edits and recovery data, install, restart and reopen old projects. Check channel/version/data compatibility and rejection of altered or wrong-publisher updates. **Done when:** the real native updater completes the supported upgrade and preserves user work; mocks and Settings screenshots are not sufficient.
- [ ] **REL-05 — Test real installation/update failure paths.** Cover interrupted download/staging/restart, low disk, expired/withdrawn metadata and return to editing after failure. Check relocation, repair, upgrade and uninstall without deleting user resumes. **Done when:** users retain a usable app or a documented recovery path, and signed artifacts remain intact.

Sources: [Mac signing](MAC_SIGNING.md), [app updates](APP_UPDATES.md), [release pipeline](RELEASE_PIPELINE.md), [OS qualification](MAC_OS_QUALIFICATION.md).

## 9. Finish documentation, Skill, website and publication

- [ ] **DOC-01 — Reconcile historical status pages.** Update current summaries after integration while preserving dated evidence. Known mismatches include the old 21-suite README summary, completed qualification described as pending in older entries, and the keyboard guide describing two tabs and a retained editor instance. The integrated app has Chat/Code/Git and disposes the hidden editor view. **Done when:** current guidance points to the right source/release and historical claims stay tied to their original versions.
- [ ] **DOC-02 — Audit every feature against its tutorial/demo.** Complete PDF highlights, verify current page-navigation instructions, and cover any new visible control or failure/recovery path introduced by remaining fixes. Add a genuine successful-update demo after real signed updates work. Preserve screenshot provenance and synthetic/live-provider labels. **Done when:** the final feature matrix accounts for every shipped feature; concept screens are not used as proof of functionality.
- [ ] **DOC-03 — Finish user and developer release guidance.** Verify install/offline use, prerequisites, provider setup/privacy/billing, saves/recovery, limits, troubleshooting, builds/tests, runtime identities, signing, updates and contribution commands against the released version. **Done when:** the guides are reproducible and no source-only feature is advertised as available in an older download.
- [ ] **DOC-04 — Refresh and validate the documentation Skill.** Regenerate references, check local links and representative assistance tasks, package the Skill with the matching release, and update the installed copy after merged changes. Back up and protect any local customizations. **Done when:** repository, distributed and intentionally installed versions contain the appropriate current guidance; validation does not overwrite user changes.
- [ ] **WEB-01 — Deploy the updated themed website.** Publish the merged gallery and later new tutorials, check desktop/mobile layout, theme persistence, navigation and download links, then verify the actual deployed page. The earlier domain repair is complete; a new hosting change is not presumed necessary. **Done when:** HTTPS pages and gallery show the intended version, and their claims match available artifacts.
- [ ] **PUB-01 — Publish one coherent final release.** Tag the reviewed source, publish the exact arm64 DMG/ZIP, checksums, provenance, source/docs/Skill archives, required third-party materials and honest release notes. Keep caches, credentials, private resumes and unnecessary test profiles out of Git. **Done when:** re-downloaded artifacts verify, main CI/deployment are successful, links work, and the release clearly distinguishes resolved issues from any accepted limitations.

Sources: [delivery scope](DELIVERY_SCOPE.md), [feature matrix](FEATURE_GUIDE_INDEX.md), [demo reproduction](demos/README.md), [documentation Skill](DOCUMENTATION_SKILL.md), [release pipeline](RELEASE_PIPELINE.md).

## Original acceptance targets still need final evidence

These are targets from the plan, not new claims that the app meets them on every Mac.

| Target | Evidence still needed |
| --- | --- |
| Editable installed project within 5 seconds, excluding first-run verification | Repeatable results on the chosen reference devices with recovery state recorded. |
| Warm preview p95 below 3 seconds after debounce | Representative supported-device samples, separate from the existing development-Mac corpus result. |
| Cold compilation below 15 seconds | Defined cold-cache corpus and separate first-run resource preparation measurements. |
| Compiler process tree stops within 2 seconds | End-to-end cancel/timeout/crash checks and enough observations across supported setups. |
| Recovery loss within the configured interval, initially targeted at 2 seconds | Final-app save/recovery/durability checks with known changes and interruption times. |
| Offline template fidelity and exact current-PDF export | Final signed app on a clean machine, including text/links/layout and actual exported-byte checks. |
| Bounded resources | The release-wide limits and acceptance in PERF-01 through PERF-09. |
| Installer under 750 MB compressed and under 2 GB installed, initially proposed | Final signed download/installed measurements; record any justified target revision explicitly. |

## Dependencies and what can proceed now

| Dependency | Work it affects | Work that can proceed without it |
| --- | --- | --- |
| Available engineering time | The goal is paused; this request documents the backlog. | Review and maintain this checklist. Implementation can resume when directed. |
| Apple Developer ID/notarization credentials and production publisher identity | REL-01, real parts of REL-02 through REL-05, signed-base pack and live-provider acceptance. | Local fixes, docs, source tests, license/material review and unsigned candidate checks. |
| Clean and physical Apple silicon test environments | MAC-01 through MAC-06 and supported-device performance/isolation acceptance. | Prepare reproducible fixtures and run available development-host checks with their limits stated. |
| Authorized real provider accounts/API access | AI-01, AI-02 and real-provider timings. | Protocol/error fixtures, protected-storage checks and synthetic documentation. |
| Resolved third-party source/license/build evidence | LIC-01 through LIC-05 and final distribution approval. | Continue the audit without changing already published artifact claims. |

## Completion rule

Each checked item must link to its change, exact tested source/app, reproducible check and result. If a check fails, keep the failure and record the repair or remaining limitation. If a requirement changes, record the explicit scope decision; do not quietly mark it done.

The release is complete only when the agreed app behavior, final artifact checks, supported-Mac acceptance, required third-party materials, documentation, Skill, website and publication all agree. A merged PR, passing source CI, successful screenshot or signed file alone does not meet that rule.

Deferred work stays deferred: structured forms, source-to-preview navigation, a broad TeX Live compatibility pack, lossless arbitrary-TeX/form conversion, cloud sync/collaboration and extra platforms are not silently added to this release checklist.
