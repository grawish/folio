# Folio licensing

Folio's original code and accompanying original documentation and examples use the [PolyForm Noncommercial License 1.0.0](../LICENSE). Keep the [required notice](../NOTICE) and license with redistributed copies. The license's full terms govern permitted use, modification and distribution.

The project is intended for noncommercial community use. It is **source-available**, not OSI open source: the [Open Source Definition](https://opensource.org/osd) permits business use and does not allow a general commercial-use restriction. The repository, README and release descriptions must use the accurate wording.

## Your documents

Folio does not claim ownership of the resume text, project files or other content you bring to the app. The application's license is not a license grant for somebody else's documents. Fonts and other third-party materials embedded in exported files may have their own terms.

## Third-party components

Electron, React, PDF.js, CodeMirror, fonts, Tectonic, Biber, TeX resources and other dependencies retain their own licenses. A noncommercial restriction on original Folio work must not be applied to their separately licensed code or resources. Preserve their attribution, redistribution, source-offer and other requirements where applicable.

[THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md) is currently a development inventory. It is not yet a complete redistribution package. Before public release, collect the required license texts and corresponding-source materials, generate an SBOM, and validate the exact installed app and source archive against that inventory. The package configuration includes the original-work LICENSE and NOTICE. Earlier unsigned local development artifacts predate that packaging change; neither those artifacts nor the source release establish completion of the binary redistribution audit.

## Reproduce the dependency inventory

Run `node scripts/collect-license-materials.mjs` after `npm ci`. It writes unmodified installed npm production license texts, Electron's upstream license and Chromium notices, a CycloneDX npm SBOM, and an inventory with file hashes under ignored `artifacts/license-materials/`. It fails on required missing packages or lock/version mismatches and explicitly lists missing license texts.

The first local inventory collected 22 installed npm production packages and Electron 44.4.5 notices. The optional native `@napi-rs/canvas-darwin-arm64` package has no top-level license text and remains flagged for review. The npm SBOM is not a full app SBOM: Tectonic, TeX resources/fonts, Biber's embedded dependencies, linked native components, corresponding-source requirements and the final signed artifact still need their separate inventory. This tool does not mark the binary audit complete or automatically publish its output.

## Collect compiler source materials

`node scripts/collect-runtime-license-materials.mjs` collects four upstream source archives: Tectonic 0.17.0, its pinned reference-source and HarfBuzz submodules, and Biber 2.17. Their exact commits, archive sizes, SHA-256 digests and selected notice/build files are reviewed in `resources/runtime-license-sources.lock.json`. The script refuses changed compiler versions, corrupt cached archives and oversized downloads. It reads named archive members without extracting filesystem paths or executing upstream code.

The output is `artifacts/license-materials/compiler-sources/`, with the original archives, 17 unmodified notice/readme/build files and a hashed inventory. Downloads stay in ignored `.cache/license-sources/`; rerun with `--offline` to require those cached inputs. These source families are a concrete start to the compiler audit, not proof that all code in the binary has been inventoried. Rust/native linked dependencies, Biber's bundled Perl libraries, individual TeX resources/fonts and the final redistribution obligations remain listed in the inventory. These archives are not automatically added to the public source release or installed app.

## Collect locked Rust sources and notices

After collecting the compiler sources above, run `python3 scripts/collect-rust-license-materials.py` with Python 3.11 or later. This developer tool reads `Cargo.lock` directly from the verified Tectonic source archive and checks every downloaded crate against its recorded SHA-256. It preserves original archives and selected notice, manifest and provenance files under ignored `artifacts/license-materials/compiler-rust/`. It does not build dependencies or extract archive paths to the filesystem. Use `--offline` to repeat collection entirely from verified cached inputs, or `--workers 1` to reduce concurrent downloads.

The verified source inventory contains 437 registry crates (82,289,482 archive bytes), 770 notice files from those crates and 26 workspace package records. Thirteen crates without included notice texts now have 17 additional upstream notices tied to the exact repository commit recorded inside their checked crate. The reviewed URLs, sizes, digests and provenance are in `resources/rust-license-notices.lock.json`; a changed source identity or notice fails collection. The collector's eight offline controls cover exact bytes, package identity, corrupt caches, unsafe paths, links and supplemental-notice provenance. Source CI runs those controls without downloading the upstream source corpus. See the [verification record](releases/rust-source-verification.json).

Two crates in the full lockfile still lack verified notice text: `rustls-platform-verifier-android@0.1.1` has no packaged VCS commit metadata, and `seahash@4.1.0` needs its exact-commit upstream notice. The Apple silicon build audit below excludes both from its resolved units and original build log. Their missing notices remain recorded for other targets/features; a declared license string does not supply the missing text. Cargo documents the difference between [license declarations and license files](https://doc.rust-lang.org/cargo/reference/manifest.html#the-license-and-license-file-fields), and the registry's [archive checksum](https://doc.rust-lang.org/cargo/reference/registry-index.html#json-schema).

This inventory deliberately covers the entire upstream lockfile, including development, optional and non-Mac packages. It is **not** the exact dependency graph of the distributed Apple silicon compiler or the final app SBOM. Matching build features and targets to the binary, reviewing workspace and native components, Biber's embedded Perl libraries, TeX/fonts, corresponding-source requirements and the final signed app remain required. Generated archives and notices are not automatically published or bundled into the app. A failure during crate or supplemental-notice collection exits unsuccessfully and records `incomplete-inventory.json`; an older `inventory.json`, if present, remains the last successful collection rather than evidence that the failed attempt completed.

## Resolve the Apple silicon compiler build graph

After collecting the compiler/Rust sources and [upstream build evidence](COMPILER_PROVENANCE.md), run this on an Apple silicon Mac:

```sh
python3 scripts/resolve-compiler-rust-graph.py
python3 scripts/resolve-compiler-rust-graph.py --offline
python3 tests/compiler-rust-graph.py
```

The audit downloads the official Rust/Cargo 1.97.1 components using the sizes and SHA-256 digests in `resources/compiler-rust-graph.lock.json`. It puts them in a temporary audit directory, not a system installation. It checks the exact executable versions/commits and uses the original source, all checksum-verified vendored crates, target, workspace, default features and release build settings. Cargo runs offline with a private configuration. Source paths cannot create links or escape the temporary directory; no dependency build scripts or compiler jobs run.

Cargo's [unit graph](https://doc.rust-lang.org/cargo/reference/unstable.html#unit-graph) preserves separate host/target units and their features. This diagnostic is unstable, so the audit enables it with `RUSTC_BOOTSTRAP=1` on the exact upstream stable Cargo executable; the [pinned Cargo source](https://github.com/rust-lang/cargo/blob/c980f4866141969fab6254a680546a277789d6f0/src/cargo/core/features.rs#L1467-L1488) explains that gate. This is a diagnostic reconstruction, not the upstream build's own recorded unit graph. The ordinary stable dependency tree must match the tree with that diagnostic override, the lockfile must remain unchanged, and the resolved package names/versions must match **only** the original release-build step. Tool installation and later tests are excluded from that comparison. A missing or extra package fails the audit.

The verified result has 445 units across 330 packages: 304 registry crates and 26 workspace packages. All 330 names/versions match the original successful release-build log. Starting at the `tectonic` executable selects 436 units across 327 packages, including 303 registry crates. The other three packages belong only to other workspace build targets. The remaining 133 registry packages in the full lockfile are unselected. All 304 selected registry crates map to retained notice texts: 534 files whose bytes and digests are checked. The selected HarfBuzz bridge has no `external-harfbuzz` feature; native linkage still requires review.

Output stays in ignored `artifacts/license-materials/compiler-rust-graph/`: the unit graph, Cargo metadata/tree, selected notice paths and an inventory. Disposable source paths are normalized for reproducible records. The [verification record](releases/compiler-rust-graph-verification.json) records exact inputs, outputs and the eight offline controls. Source CI runs those controls without downloading or running a Rust toolchain.

This narrows the license review to the actual release build and separates the executable's build dependencies from other workspace targets. It does **not** prove which functions survive linking, inventory Rust standard-library code, or complete workspace/native/Biber/TeX/font obligations and the final app SBOM. Host tools and procedural macros stay in the build closure; they are not mislabeled as linked runtime libraries. Original full source archives remain available in the separate inventories. No installer or published release asset is changed by this developer audit.

## Collect native build-port sources and notices

Run `python3 scripts/collect-native-license-materials.py` after retaining the [verified vcpkg build inputs](COMPILER_PROVENANCE.md#reproduce-the-check). The Python 3.11+ collector checks `resources/native-license-sources.lock.json` against the compiler-build evidence lock and original vcpkg archive. Every selected port must match its installed version/features, recipe and manifest. Its source archive must match the recipe’s SHA-512 plus the reviewed byte count and SHA-256. Downloads use approved HTTPS hosts and bounded redirects, sizes and time; cached corruption fails instead of fetching a replacement.

The collected set contains 11 original archives (86,246,832 bytes) and 33 unmodified notice files (182,380 bytes): Brotli, bzip2, Expat, zlib, libpng, FreeType, Fontconfig, Graphite2, HarfBuzz, ICU and the gperf build tool. The full archives preserve source headers and other materials beyond the selected notice files. The source-build inventory separately retains the vcpkg recipes and patches. See [the verification record](releases/native-source-verification.json) for individual hashes and scope.

```sh
python3 scripts/collect-native-license-materials.py
python3 scripts/collect-native-license-materials.py --offline
python3 tests/native-license-materials.py
```

Output stays under ignored `artifacts/license-materials/compiler-native/`; the original cache is `.cache/license-sources/native/`. Collection reads archive members without extracting archive paths or executing code. Eleven offline controls cover altered archive sizes/digests, mismatched build evidence/recipes, changed versions/features, missing notices, unsafe paths, links, duplicate members, forbidden redirects and preservation of prior successful evidence when a run fails. Source CI runs these controls without downloading the source corpus. A failed collection writes `incomplete-inventory.json` and exits unsuccessfully; an existing `inventory.json` remains the last successful run.

This is a source inventory of selected installed **build ports**, including a build tool and potentially unused components. It does not establish that all 11 are linked into Folio’s compiler, choose between license options, or complete corresponding-source/redistribution review. Four macOS compatibility ports and five build-helper ports remain classified separately in the lock; helper tool payloads, exact target/features/linkage, Biber/Perl, TeX/fonts and the final signed-app SBOM still need review. No existing public release asset is changed, and generated files are not automatically included in future installers.

## License provenance

The [compiler build provenance check](COMPILER_PROVENANCE.md) connects the bundled Tectonic executable byte for byte to its retained original upstream build artifact. It also verifies the build's 20 installed native port versions and preserves 139 recipe/patch/manifest and root notice files. The native collector above now retains 11 payload archives and 33 notices. Final linkage and remaining materials still need review; installed build dependencies are not automatically shipped libraries.

The root LICENSE is copied without modifications from the [official PolyForm license repository at tag 1.0.0](https://github.com/polyformproject/polyform-licenses/blob/1.0.0/PolyForm-Noncommercial-1.0.0.md). The original project copyright notice is separate in NOTICE. The [PolyForm project](https://polyformproject.org/licenses/noncommercial/1.0.0) publishes the same standard terms.
