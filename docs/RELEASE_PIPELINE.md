# Publication and release pipeline

The first reviewed source commit was pushed to `grawish/folio` before these workflows were added, as requested. Only source, tests, docs, synthetic screenshots, templates and required static assets are tracked. Local profiles, private design captures, runtime downloads, old installers and caches stay ignored.

## What runs

| Workflow | Trigger | Result |
| --- | --- | --- |
| Check source | Main pushes, pull requests, manual | Formatting, unit tests, typecheck/build, website build and generated-skill consistency |
| Publish website | Relevant main changes or manual | Static site deployment to GitHub Pages |
| Release source preview | `source-v*` tag | Tested source/docs/skill archives, checksums and provenance in a public prerelease |
| Qualify Apple silicon candidate | Manual | Fresh runtime setup, real compiler integration, arm64 packaging, nine native suites and artifact verification |

Official actions are pinned to immutable revisions. Jobs have bounded timeouts. Pull requests use read-only repository permissions and receive no provider keys or signing credentials. Native suites run sequentially. Qualification publishes test metadata/logs, not a downloadable compiler bundle or installer while the binary redistribution audit remains unfinished.

The Mac jobs use the standard `macos-15` arm64 runner listed in [GitHub's runner documentation](https://docs.github.com/en/actions/reference/runners/github-hosted-runners). Pages uses the dedicated permissions and environment described in [GitHub's Pages workflow documentation](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages).

## Publish a source preview

From a clean, reviewed main commit, choose a new `source-vX.Y.Z-preview.N` tag, push it, and inspect the **Release source preview** run. Do not move an existing release tag. The workflow checks that the tag points at the checkout, tests the source, packages only tracked files, and publishes a prerelease with SHA256SUMS and the exact commit in provenance.json.

A source prerelease is not a signed Mac application release. Building the binary candidate and passing checks does not close the remaining license, signing, updater and platform requirements. Those stay in [the release audit](RELEASE_GAP_AUDIT.md).

## Production app release work remaining

Complete third-party redistribution/source materials and a binary SBOM; implement signing-aware runtime manifests; provision the owner's Developer ID/notarization credentials; sign and notarize the app and installer; qualify that exact signed artifact; complete supported-OS and upgrade acceptance. Then add artifact publication and authenticated update metadata. There is no updater in this preview, and the pipeline never invents signing credentials or skips an integrity failure.

## Website

`npm run website:build` generates `.site/` from `website/`, the app's actual theme tokens and font, template previews and curated tutorial screenshots. It needs no account secrets, analytics service, or runtime compiler. GitHub Pages serves it at `https://grawish.github.io/folio/`. The source and licenses remain linked from the site.
