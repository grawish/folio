# Compiler build provenance

Folio's included Apple silicon Tectonic 0.17.0 executable is an exact byte match for the original upstream build artifact. This connects the binary to an actual successful build, its release source commit and its native dependency recipes. It does not by itself complete the compiler's license audit or the final app SBOM.

## Verified chain

The upstream [release tag](https://github.com/tectonic-typesetting/tectonic/releases/tag/tectonic%400.17.0) resolves through annotated tag `7141d67aba85eb1cf38a769eac0b1bb2180c51d7` to source commit `8c0126a9653239a2e6e0a5274af9b8510f643030`. The [Apple silicon build job](https://github.com/tectonic-typesetting/tectonic/actions/runs/30227680364/job/89864241906) records restoring that generated release commit from its input `f617f15912e26fe5300015f6fd26fdb639d53d60`.

Its retained `binary-aarch64-apple-darwin` artifact, ID `8639168690`, has the SHA-256 reported by GitHub. The artifact contains one release archive; that archive is byte-identical to Folio's pinned download. Its single executable is byte-identical to `resources/runtime/mac-arm64/tectonic`:

| Object | Bytes | SHA-256 |
| --- | ---: | --- |
| Release archive | 21,704,674 | `a3f1cac7c5678f01661a92212f58480ae3b0634115d880dbc59e2953ded45667` |
| Compiler executable | 53,998,928 | `b52b5a730e2b0b33087304f7720f649603953f270a6b1c88bb031e1ae01f7f9c` |

The job records Rust/Cargo 1.97.1, Cranko 0.17.3, the `aarch64-apple-darwin` target, the vcpkg dependency backend and vcpkg commit `a62ce77d56ee07513b4b67de1ec2daeaebfae51a`. That native dependency revision also matches the verified source manifest. All 20 installed port versions and features match the original build log and their manifests in the pinned vcpkg archive.

`resources/compiler-build-provenance.lock.json` pins the evidence and archive bytes. The [verification record](releases/compiler-build-verification.json) contains the checked hashes and installed-port inventory. GitHub may expire upstream artifacts/logs; retain the verified local inputs when preparing the eventual redistribution materials.

## Reproduce the check

Run `npm run setup` and the [compiler source collector](LICENSING.md#collect-compiler-source-materials) first. Fetch these public audit inputs into `.cache/license-sources/`; GitHub CLI handles its own authentication without writing a token into these commands:

```sh
gh api repos/tectonic-typesetting/tectonic/actions/artifacts/8639168690/zip > .cache/license-sources/tectonic-arm64-upstream-build-artifact.zip
gh api repos/tectonic-typesetting/tectonic/actions/jobs/89864241906/logs > .cache/license-sources/tectonic-0.17-arm64-upstream-build.log
curl --fail --location --proto '=https' --output .cache/license-sources/vcpkg-a62ce77d56ee07513b4b67de1ec2daeaebfae51a.tar.gz https://codeload.github.com/microsoft/vcpkg/tar.gz/a62ce77d56ee07513b4b67de1ec2daeaebfae51a
python3 scripts/collect-compiler-build-evidence.py
python3 tests/compiler-build-evidence.py
```

The Python 3.11+ collector requires cached inputs, checks their locked bytes and writes only under ignored `artifacts/license-materials/compiler-build/`. It verifies the actual Folio compiler without executing it, and preserves the build log plus 139 unmodified vcpkg manifests, recipes, patches and root license/triplet files. It never executes a recipe or extracts archive paths to the filesystem. Six controls reject substituted compiler bytes, mismatched digests/sizes, links and unexpected archive members. Source CI runs the controls without downloading the compiler.

## What remains

An installed build dependency is not automatically part of the final executable. The 20 ports include build helpers and tools; some recipes produce empty compatibility packages on macOS. For example, the pinned [dirent recipe](https://github.com/microsoft/vcpkg/blob/a62ce77d56ee07513b4b67de1ec2daeaebfae51a/ports/dirent/portfile.cmake), [pthreads recipe](https://github.com/microsoft/vcpkg/blob/a62ce77d56ee07513b4b67de1ec2daeaebfae51a/ports/pthreads/portfile.cmake) and [libiconv recipe](https://github.com/microsoft/vcpkg/blob/a62ce77d56ee07513b4b67de1ec2daeaebfae51a/ports/libiconv/portfile.cmake) have platform-specific early returns. The compiler's dynamic-library list also cannot enumerate code linked statically.

Use the preserved recipes to collect exact native payload sources and license texts, then resolve the final target/features and linkage. Preserve the separate Rust source inventory, workspace/native source notices, Biber's embedded dependencies and TeX/font requirements. The collected recipes are build evidence, not the native dependency payloads themselves. Do not describe this record as permission to publish an installer or as a completed signed-app audit.
