# Publication and release pipeline

The first reviewed source commit was pushed to `grawish/folio` before these workflows were added, as requested. Only source, tests, docs, synthetic screenshots, templates and required static assets are tracked. Local profiles, private design captures, runtime downloads, old installers and caches stay ignored.

## Current hosting state

Source, guides, screenshots and the skill are published on main. The owner approved the missing workflow scope, and all four workflows were pushed in b25952e. [Hosted source checks](https://github.com/grawish/folio/actions/runs/36194553795) passed: npm clean install, formatting, all 123 unit tests, typecheck/build, site build and generated-skill consistency. The [custom Pages deployment](https://github.com/grawish/folio/actions/runs/36194553881) also passed.

The first [hosted Apple silicon candidate](https://github.com/grawish/folio/actions/runs/36188323034) passed runtime setup, unit/compiler integration tests, packaging and seven native suites: import recovery, import, PDF viewer, PDF lifecycle, compiler migration, chat and runtime repair. The workspace suite failed at its pane-resizing assertion (expected width greater than 486, received 432). This exact result was reproduced locally at the supported 1040-pixel window: the app correctly preserves the PDF pane's minimum width, but the test assumed more room. The test now checks the allowed drag range and complete-buffer undo at both window sizes; see [workspace verification](WORKSPACE_PREFERENCES.md#verification). The final packaged smoke and artifact-verification steps did not run in that hosted attempt, so it does not qualify the candidate for release. Logs and native-tests.json were retained; future runs also retain workspace geometry and failure screenshots.

The fresh [hosted Mac rerun](https://github.com/grawish/folio/actions/runs/36192380246) at c861ead3558ac2b72edabdbc263d8b52e5e3a114 passed all nine native suites and final artifact verification. All 37 packaged build outputs matched, the runtime manifest matched, and the disk image passed integrity verification. Downloaded metadata and script hashes were checked against that exact commit; see the [verification record](releases/mac-candidate-verification.json). This establishes the earlier unsigned baseline. The later compiler-help commit 1afb193 passed hosted source checks and separate local source/package diagnostic checks; its additional tenth suite was not part of this earlier run. No signed installer or runtime binary has been published.

The local-font commit 22829fd passed [hosted source checks](https://github.com/grawish/folio/actions/runs/36220931912) with 130 unit tests and [Pages deployment](https://github.com/grawish/folio/actions/runs/36220931941). Its 24-demo gallery was verified live. The expanded [eleven-suite Mac qualification](https://github.com/grawish/folio/actions/runs/36220947706) is a separate run; do not infer completion from source checks or deployment. The newer support-bundle feature has targeted local source/package evidence in [SUPPORT_BUNDLES.md](SUPPORT_BUNDLES.md); it expands future qualification to twelve suites.

The [first source prerelease](https://github.com/grawish/folio/releases/tag/source-v0.1.0-preview.1) contains source, documentation, skill, checksums and provenance. Its uploaded archive digests match the local files. It was published with the CLI before custom workflow permission was granted. [Source preview 2](https://github.com/grawish/folio/releases/tag/source-v0.1.0-preview.2) was then published end to end by [the release workflow](https://github.com/grawish/folio/actions/runs/36188959516). Its provenance identifies efd41c7a43f99e71c5aece4a0a19047b66f005ff on a Darwin arm64 runner; all archive digests match its published checksums.

The website is live at [grawish.com/folio](https://grawish.com/folio/) with its [demo gallery](https://grawish.com/folio/demos.html). The initial Cloudflare HTTP 526 was repaired with the owner's explicit approval: remove the conflicting apex A record, temporarily expose the four GitHub Pages records as DNS only, re-add the custom domain to trigger certificate provisioning, then restore Cloudflare proxying. GitHub reports an approved certificate for grawish.com and www.grawish.com, expiring 25 December 2026, with HTTPS enforced. Cloudflare Full (strict) remains enabled. Final normal HTTPS requests returned 200 for the main site, Folio and the gallery, and the live Folio page was visually checked. [Verification record](releases/website-verification.json).

An initial branch-based deployment also passed before workflow access was granted. Pages now uses the custom workflow; the old gh-pages branch is retained.

## Workflows


| Workflow | Trigger | Result |
| --- | --- | --- |
| Check source | Main pushes, pull requests, manual | Formatting, unit tests, typecheck/build, website build and generated-skill consistency |
| Publish website | Relevant main changes or manual | Static site deployment to GitHub Pages |
| Release source preview | `source-v*` tag | Tested source/docs/skill archives, checksums and provenance in a public prerelease |
| Qualify Apple silicon candidate | Manual | Fresh runtime setup, real compiler integration, arm64 packaging, twelve native suites (including compiler help, local fonts and support export) and artifact verification |

Official actions are pinned to immutable revisions. Jobs have bounded timeouts. Pull requests use read-only repository permissions and receive no provider keys or signing credentials. Native suites run sequentially. Qualification publishes test metadata/logs, not a downloadable compiler bundle or installer while the binary redistribution audit remains unfinished.

The Mac jobs use the standard `macos-15` arm64 runner listed in [GitHub's runner documentation](https://docs.github.com/en/actions/reference/runners/github-hosted-runners). Pages uses the dedicated permissions and environment described in [GitHub's Pages workflow documentation](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages).

## Publish a source preview

From a clean, reviewed main commit, choose a new `source-vX.Y.Z-preview.N` tag, push it, and inspect the **Release source preview** run. Do not move an existing release tag. The workflow checks that the tag points at the checkout, tests the source, packages only tracked files, and publishes a prerelease with SHA256SUMS and the exact commit in provenance.json.

A source prerelease is not a signed Mac application release. Building the binary candidate and passing checks does not close the remaining license, signing, updater and platform requirements. Those stay in [the release audit](RELEASE_GAP_AUDIT.md).

## Production app release work remaining

Complete third-party redistribution/source materials and a binary SBOM; implement signing-aware runtime manifests; provision the owner's Developer ID/notarization credentials; sign and notarize the app and installer; qualify that exact signed artifact; complete supported-OS and upgrade acceptance. Then add artifact publication and authenticated update metadata. There is no updater in this preview, and the pipeline never invents signing credentials or skips an integrity failure.

## Website

`npm run website:build` generates `.site/` from `website/`, the app's actual theme tokens and font, template previews and curated tutorial screenshots. It needs no account secrets, analytics service, or runtime compiler. The normal GitHub Pages address is `https://grawish.github.io/folio/`, which can redirect to the account’s inherited custom domain. The source and licenses remain linked from the site.
