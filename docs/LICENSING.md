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

The [packaged Mac app inventory](MAC_APP_INVENTORY.md) now records every physical file, directory and internal link in one exact development app, verifies its runtime manifest and emits a schema-validated CycloneDX record with explicitly incomplete component coverage. It provides the artifact inventory to connect with the source evidence below. Embedded archives, linked components, complete license mapping and the final signed-app SBOM remain open. Its vendored CycloneDX schemas retain their original Apache 2.0 license under `resources/sbom-schema/`; the schema validators are developer dependencies.

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

## Collect Rust standard-library materials

Tectonic's Cargo lockfile does not list the code supplied by Rust itself. `python3 scripts/collect-rust-standard-library.py` collects the official Rust 1.97.1 source component and its prebuilt Apple silicon standard-library component. Use `--offline` to require the existing cache. The collector checks the official release manifest, pinned archive sizes/digests, embedded version/commit files and the previously verified Tectonic build/toolchain records. The actual compiler binary also contains the matching `/rustc/8bab26f4f68e0e26f0bb7960be334d5b520ea452/` source identifier.

The two original archives total 34,947,020 bytes. Collection preserves 79 notice files, including Rust's root notices, the compiler-builtins and libm license texts, the included LLVM libunwind notice and vendored crate notices. It also retains source manifests, lockfiles and checksum manifests: 258 selected material files in total. All 1,161 declared files in the 30 vendored source packages match their embedded checksums, and their package checksums agree with the standard-library lockfile.

The prebuilt component contains 27 `.rlib` archives. Each has a matching locked source package and retained source manifest; its bytes and SHA-256 are recorded. Twelve are registry packages, and each has collected notice text. The wider source archive also contains other targets and tests: three source-only packages (`fortanix-sgx-abi`, `vex-sdk`, `wasip1`) lack separate notice files and are not among these 27 prebuilt libraries. This collection does not silently approve them for another target.

```sh
python3 scripts/collect-rust-standard-library.py
python3 scripts/collect-rust-standard-library.py --offline
python3 tests/rust-standard-library.py
```

Inputs are pinned in `resources/rust-standard-library.lock.json` and cached in `.cache/compiler-audit/toolchain-archives/`. Output is ignored `artifacts/license-materials/rust-standard-library/`, including both complete original archives, the official manifest, unmodified selected materials and an inventory. The tool reads bounded archive entries in memory; it never extracts archive paths or executes upstream code. Six offline controls check source identity, notices, vendored checksums, binary-to-source mapping, unsafe archives and unreviewed downloads. See [verification](releases/rust-standard-library-verification.json).

This supplies the standard-library source and notice materials missing from the Tectonic crate inventory. The 27 prebuilt libraries are a toolchain inventory, not a claim that all of them are linked into Tectonic. They include compiler/test support. Final linked-component mapping and the wider native/workspace, Biber/Perl, TeX/font and exact-app SBOM review remain required. Generated files are not automatically added to existing releases or installers.

## Collect Biber payload and foundation sources

`python3 scripts/collect-biber-build-evidence.py` checks that the prepared Apple silicon Biber is the exact arm64 slice of the checksum-locked official universal executable. It reads its embedded PAR payload without running Perl or extracting archive paths, then checks every prepared cache file against both that payload and the runtime manifest. All 3,979 files (247,211,520 bytes) have byte provenance: 3,974 match stored files, two scripts add the packager's known wrapper, two native binaries use its documented 32,768-byte chunk format, and one canary matches embedded text.

The embedded ZIP has 3,834 distinct regular files. Two names each occur twice with identical contents; the lock records their exact bytes, digests and occurrence counts. Any other duplicate, changed duplicate, unsafe path, link or oversized member is rejected. The separate loader contributes 98 files. All 36 embedded Biber application/data files match the pinned Biber 2.17 release source.

The embedded configuration identifies Perl 5.32.1, PAR 1.017 and PAR::Packer 1.055. The collector retains their three complete source archives (18,311,436 bytes), 25 original notice/metadata/build materials, and an inventory of exact source-to-payload matches: 228 Perl files, four PAR files and three PAR::Packer files. The packager's original chunk-generation scripts are included. These matches support provenance; they do not establish a reproducible native binary build.

Prepare the runtime and cached Biber release source first:

```sh
npm run setup
node scripts/collect-runtime-license-materials.mjs
python3 scripts/collect-biber-build-evidence.py
python3 scripts/collect-biber-build-evidence.py --offline
python3 tests/biber-build-evidence.py
```

`resources/biber-build-provenance.lock.json` pins the inputs. `resources/biber-foundation-releases.json` retains the reviewed identity, checksum, download URL and license fields from official MetaCPAN release responses, with each response's source URL and original digest. Foundation downloads use those exact pinned CPAN archives; `--offline` requires their existing cache. Selected evidence, original foundation archives and the hashed inventory go to ignored `artifacts/license-materials/biber-build/`. A failed run records `incomplete-inventory.json`; a retained older successful inventory does not describe the failed attempt. Eight offline controls and a byte-identical replay of all 35 retained output files pass; see [verification](releases/biber-build-verification.json).

The PAR metadata declares its aggregate license as `unknown`; that is not a license conclusion for every embedded dependency. The CPAN collector below adds matching dependency sources and the full Biber Artistic 2.0 text. Generated/native-library evidence, redistribution review and the final app SBOM remain open. Neither collector publishes or changes an installer or the historical compiler resource identity.

## Collect Biber CPAN source and notice materials

`python3 scripts/collect-biber-cpan-materials.py` retains 123 original CPAN source archives (30,004,935 bytes) and 727 selected notice, metadata, build and module files. The source releases are pinned in `resources/biber-cpan-sources.lock.json`. Each has at least one reviewed module whose complete bytes match the embedded Biber payload, either unchanged or after an exact documented PAR::Packer replacement. The tool preserves original source archives and source notices; it never executes Perl, builds upstream code or extracts archive paths.

The CPAN sources account for 2,756 distinct payload files. Together with the earlier Perl/PAR and Biber sources, the collector maps 3,056 of the 3,932 distinct ZIP/loader files. Four matches use the original packager's compatibility changes to `Tk.pm`, `Tk/Widget.pm`, `AutoLoader.pm` and `Pod/Usage.pm`. The collector parses only the reviewed literal string replacements from the checksum-verified `PAR::Filter::PatchContent` source, then requires an exact match of the entire resulting file. It rejects executable expressions and unsupported patch forms.

The 876 unmatched files remain in a separate inventory. They include 541 generated Unicode tables, other generated Perl/packager files, autosplit output, compiled Perl modules and native libraries. This is a source-matching inventory, not a claim that all dependencies have been audited or that every source file contributes executable code. Matching the source of a Perl module does not establish the corresponding native library's build inputs.

Forty-four source distributions have no file with a recognized standalone notice name. Their root READMEs and anchor modules are retained so the embedded POD copyright/license grants can be reviewed. The collector also retains Biber's original README and `Build.PL`, plus the complete unmodified Artistic 2.0 text from a pinned SPDX license-list commit. The README names Artistic 2.0 while `Build.PL` declares `perl`; both original declarations are preserved for redistribution review. Do not replace upstream terms with Folio's noncommercial license.

After preparing the runtime and Biber release sources as above:

```sh
python3 scripts/collect-biber-cpan-materials.py
python3 scripts/collect-biber-cpan-materials.py --offline
python3 tests/biber-cpan-materials.py
```

Downloads are limited to the reviewed CPAN archives and pinned SPDX text. Sizes, digests and original MetaCPAN release metadata URLs are recorded in the lock. A module/version lookup is only a discovery hint: the audit rejected a mismatching MIME::Charset candidate and retained the exact 1.012.2 source after byte comparison. Output goes to ignored `artifacts/license-materials/biber-cpan/`, including the full archives, selected original materials, the packager patch source and detailed match/unmatched inventories. Eight offline controls pass, and all 856 retained output files are byte-identical on a cached replay. See [verification](releases/biber-cpan-verification.json). Generated artifacts are not automatically published or bundled into Folio; final license obligations and the exact-app SBOM still require completion.

## Reproduce Biber Unicode tables

`python3 scripts/collect-biber-unicode-evidence.py` uses the cached, checksum-verified Perl 5.32.1 source archive and its 60 original Unicode input files (11,643,085 bytes). It runs the unchanged `lib/unicore/mktables` generator with `-C lib/unicore -q -w`. Keeping the original invocation path reproduces its header; output text is never edited to make a match.

This developer-only macOS check executes reviewed upstream code. It uses `/usr/bin/perl` in a sandbox that denies networking and limits writes to a unique temporary run directory and `/dev/null`. It permits reads and other system operations; it is not a read-isolation audit and does not change Folio’s application sandbox. Each run first proves that an inside write succeeds while an outside write and actual loopback connection fail with `EPERM`. The generator has a 180-second deadline that kills and reaps its process group. Inputs and output sizes are bounded, but this does not establish OS memory/CPU quotas.

The observed system Perl is 5.34.1, while the original source is Perl 5.32.1 with Unicode 13.0.0 data. Of 546 embedded Unicode files, five match unchanged source and **540 generated files reproduce byte for byte**. Seventeen generated `Sc/` files match payload `Scx/` files under different names; every mapping is recorded. The remaining `UCD.pl` index differs in ordering and references. It remains unmatched; neither normalization nor an assumed semantic match closes that gap. This is a verified subset, not a reconstruction of Biber’s full original build environment.

```sh
# Requires the previously collected Perl archive and prepared Biber runtime.
python3 scripts/collect-biber-unicode-evidence.py
python3 tests/biber-unicode-evidence.py
```

The collector is offline and retains its original archive, all 60 inputs, exact generated candidates and a hashed inventory under ignored `artifacts/license-materials/biber-unicode/`. Unique run folders and logs remain under `test-results/`. A second run reproduces all 609 retained output files identically. Eight new offline controls pass, bringing source-collector controls to 63; CI runs the controls without generating Unicode data. The [verification record](releases/biber-unicode-verification.json) preserves the interpreter identity, exact command and sandbox scope.

All 540 new generated matches were previously unmatched in the CPAN inventory. Combined evidence now covers **3,596 of 3,932 payload files**, leaving 336 explicit gaps. Other generated Perl/autosplit files, native modules/libraries, original Unicode terms, embedded license grants and full redistribution/SBOM review remain required. These developer artifacts do not modify existing app or runtime bytes and are not automatically published. A failed run exits unsuccessfully and writes `incomplete-inventory.json`; an existing `inventory.json` remains evidence of the preceding successful run.

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
