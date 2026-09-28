# Apple silicon macOS qualification

The manual **Qualify Apple silicon candidate** workflow now accepts an explicit Mac image. Its default remains macOS 15. The same source, compiler, template-image, complete native app and final archive checks run on the selected image; choosing another OS does not skip a check.

| Choice | Expected macOS major | Purpose |
| --- | --- | --- |
| `macos-14` | 14 | Proposed minimum-version compatibility |
| `macos-15` | 15 | Existing hosted qualification baseline |
| `macos-26` | 26 | Additional OS compatibility |
| `xcode-27` | 27 | Current macOS compatibility using GitHub's preview image |

These names come from [GitHub's runner reference](https://docs.github.com/en/actions/reference/runners/github-hosted-runners) and [runner image inventory](https://github.com/actions/runner-images). Checked 28 September 2026. Apple lists [macOS 27 as the current major release](https://support.apple.com/en-ca/127255). GitHub still labels its `xcode-27` runner as public preview, so the workflow records and checks the actual OS rather than inferring it from the label.

GitHub has [announced removal of macOS 14 runners on 2 November 2026](https://github.com/actions/runner-images/issues/13518). A future runner outage or retirement is not an app compatibility failure and must not silently raise Folio's proposed minimum. Continued minimum-version acceptance will need a maintained Apple silicon test environment and an explicit support decision.

## Run a qualification

After source checks pass, select the intended source branch and runner in GitHub Actions, or run:

```sh
gh workflow run mac-candidate.yml --repo grawish/folio --ref YOUR_REVIEWED_BRANCH -f runner=macos-14
gh workflow run mac-candidate.yml --repo grawish/folio --ref YOUR_REVIEWED_BRANCH -f runner=xcode-27
```

Each OS choice gets its own concurrency group and named evidence artifact. This permits independent OS runs while preserving a running attempt for the same branch/OS. Do not restart a live run just because a status request times out. Inspect the existing run ID until GitHub reports a terminal result.

Before installing dependencies, the workflow verifies native Apple silicon execution and the selected major OS version. `test-results/runner-environment.json` records OS/build/kernel versions, architecture, hardware model, logical CPUs, memory, Node version, source commit, recorder hash and GitHub image/run identifiers. It records only these selected fields, not environment variables, credentials, machine serial numbers or resume content. Mismatched OS, architecture or source fails the job; its environment report remains in the evidence artifact.

## What the result proves

A passing run proves the existing test corpus passed on the recorded hosted environment and exact built app. Inspect the retained source/script hashes, physical app inventory, native results, template PDFs/images, notices, JavaScript reproduction and archives before calling that candidate qualified. Separate OS builds must be compared explicitly; a shared source commit alone does not prove byte-identical packages.

This workflow runs on developer images with build tools. It does not prove installation on a consumer Mac without a developer toolchain, signed Gatekeeper/notarization acceptance, a signed-to-signed update, VoiceOver usability or physical high-DPI behavior. Those release requirements remain open. The minimum remains proposed until compatibility evidence and the support decision are complete.

## Verified hosted results — 28 September 2026

Both runs completed successfully at source `ae62d1ab1187241beb2537504f32bbf11917a147`. Each passed 460 source tests, 19 compiler integrations, twelve template-image comparisons with zero changed pixels, all twenty-one native suites and the final app/archive gates.

| Actual OS | Selected image | Build | Run and independent evidence |
| --- | --- | --- | --- |
| macOS 14.8.9 arm64 | `macos-14` | `23J631` | [Run 36366641244](https://github.com/grawish/folio/actions/runs/36366641244), [verification record](releases/macos-14-hosted.json) |
| macOS 27.0 arm64 | `xcode-27` | `26A428` | [Run 36366647982](https://github.com/grawish/folio/actions/runs/36366647982), [verification record](releases/macos-27-hosted.json) |

Both hosts report `VirtualMac2,1`, three logical CPUs and 7 GiB RAM. Their records retain the distinct runner image and Node versions. All 170 evidence files from each run were independently checked, including source/script hashes, physical app inventories, JavaScript reproduction, original publisher materials and exported PDFs. Startup and rebuilt-cache screenshots were visually reviewed on both systems.

The two hosted 5,879-entry app inventories are identical, including the Folio icon, application archive and compiler runtime. Their bundle inventory SHA-256 is `cd1fd7caf2d94b00203c9cd4d48c8fba8ededb9ae81123b1dd193c2a4387eb66`. They also match the retained local icon package except for the explicitly recorded hosted `app-update.yml` metadata. These comparisons establish exact payload identity across these two hosted builds.

Earlier macOS 15 records remain historical. These results establish compatibility with the recorded developer images, not every patch release, macOS 14.0, a clean consumer installation or a signed production release. The public preview-4 installer is unchanged.

The [local recorder controls](releases/mac-os-runner-controls.json) accept the actual arm64 macOS 27 host and reject both a macOS 14 label on that host and an unknown runner label. Formatting and YAML checks pass; these controls are narrower than app qualification.
