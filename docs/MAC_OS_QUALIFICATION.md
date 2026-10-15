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
The recorded hosted result establishes test-corpus compatibility on macOS 14.8.9 and 27.0 only. Folio does not presently advertise a broader minimum-version or reference-device performance promise. Any release support statement must retain those exact observed versions until clean-machine and signed-candidate evidence expands it.

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

## Editor integration results — 28 September 2026

Source `0bee2713cff6eed7872984f73229fec7ef722ff3` passes the complete current 24-suite hosted qualification on both recorded Mac images. Each run also passes 486 source tests, 19 compiler integrations, twelve template-image comparisons with zero changed pixels, and final app/archive verification. The added checks cover file navigation and saved editor state, outside-file reloads and the local Git workflow. The repaired workspace check follows all three tabs; recovery retains the exact four accepted/96 rejected native write assertion.

| Actual OS | Build | Run and independent evidence |
| --- | --- | --- |
| macOS 14.8.9 arm64 | `23J631` | [Run 36381748745](https://github.com/grawish/folio/actions/runs/36381748745), [verification](releases/editor-lifecycle-macos-14-hosted.json) |
| macOS 27.0 arm64 | `26A428` | [Run 36381751031](https://github.com/grawish/folio/actions/runs/36381751031), [verification](releases/editor-lifecycle-macos-27-hosted.json) |

Both environments report `VirtualMac2,1`, three logical CPUs and 7 GiB RAM. All 178 downloaded evidence files per run, source/script hashes, actual template pixels, generated PDFs, packaged notices, JavaScript reproduction and original publisher materials pass independent checks. The two 5,879-entry physical inventories are byte-identical, with SHA-256 `01cff0fb4b0b8eb3d7815aa30c0cde23ec6243a466fd6fa2babed79bd4fbf4c5`. Their ASAR is `7ab490486ba31a5a0b487231f7c176c756a22cff61869832c88bdd63373d99be`; the 3,982-file compiler runtime is unchanged. Comparison with the preserved local package differs only in explicitly recorded hosted updater metadata.

The [initial viewport failures](releases/editor-navigation-initial-failures.json) and [later recovery/keyboard failures](releases/editor-integrated-hosted-failures.json) remain preserved. The latest qualification includes their fixes. This is coverage of the recorded test corpus on developer images. The merged PDF-change overlay still needs its separate native workflow check and tutorial; it is not asserted by these 24 suites. Clean consumer installation, physical input/accessibility, signing, full redistribution and application-wide resource acceptance remain open. The later unsigned preview 5 passed source CI and packaged smoke checks, not this full hosted campaign.

### PDF-change overlay gap closed on developer hardware

The native workflow check and tutorial this section flagged as missing landed on main at `95e1159` (28 September 2026): `scripts/test-pdf-highlight-smoke.mjs`, ordinary/delayed/inserted/removed-page scenarios, and the [chat tutorial's Show-changes walkthrough](tutorials/chat-and-feedback.md#see-what-the-ai-changed). This was run and verified on the developer's local arm64 Mac only (`npm run test:pdf-highlight`, `docs/releases/pdf-highlight-fix-verification.json`); it has not yet been re-qualified on hosted macOS 14/27 images. The next hosted qualification run should include it in the recorded suite count.

## Earlier icon-only results — 28 September 2026

Both runs completed successfully at source `ae62d1ab1187241beb2537504f32bbf11917a147`. Each passed 460 source tests, 19 compiler integrations, twelve template-image comparisons with zero changed pixels, all twenty-one native suites and the final app/archive gates.

| Actual OS | Selected image | Build | Run and independent evidence |
| --- | --- | --- | --- |
| macOS 14.8.9 arm64 | `macos-14` | `23J631` | [Run 36366641244](https://github.com/grawish/folio/actions/runs/36366641244), [verification record](releases/macos-14-hosted.json) |
| macOS 27.0 arm64 | `xcode-27` | `26A428` | [Run 36366647982](https://github.com/grawish/folio/actions/runs/36366647982), [verification record](releases/macos-27-hosted.json) |

Both hosts report `VirtualMac2,1`, three logical CPUs and 7 GiB RAM. Their records retain the distinct runner image and Node versions. All 170 evidence files from each run were independently checked, including source/script hashes, physical app inventories, JavaScript reproduction, original publisher materials and exported PDFs. Startup and rebuilt-cache screenshots were visually reviewed on both systems.

The two hosted 5,879-entry app inventories are identical, including the Folio icon, application archive and compiler runtime. Their bundle inventory SHA-256 is `cd1fd7caf2d94b00203c9cd4d48c8fba8ededb9ae81123b1dd193c2a4387eb66`. They also match the retained local icon package except for the explicitly recorded hosted `app-update.yml` metadata. These comparisons establish exact payload identity across these two hosted builds.

Earlier macOS 15 records remain historical. These results establish compatibility with the recorded developer images, not every patch release, macOS 14.0, a clean consumer installation or a signed production release. The later unsigned preview 5 passed source CI and packaged smoke checks, not this full hosted campaign.

The [local recorder controls](releases/mac-os-runner-controls.json) accept the actual arm64 macOS 27 host and reject both a macOS 14 label on that host and an unknown runner label. Formatting and YAML checks pass; these controls are narrower than app qualification.
