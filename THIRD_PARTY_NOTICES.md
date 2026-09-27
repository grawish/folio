# Third-party resources — development preview

Folio's dependency versions are recorded in `package-lock.json`. Dependency packages retain their own license files. The
LaTeX resource inventory and SHA-256 hashes are recorded in `resources/bundle.lock.json` and copied into each prepared
runtime.

- **electron-updater 6.8.10** and **builder-util-runtime 9.7.0**: MIT, https://github.com/electron-userland/electron-builder. The app update path also includes their locked runtime dependencies, including semver (ISC), js-yaml (MIT), fs-extra (MIT), lazy-val (MIT), lodash helper packages (MIT), and tiny-typed-emitter (MIT). Their individual license texts are collected by `scripts/collect-license-materials.mjs`; this does not close the broader native/compiler license audit.

  The app includes `Contents/Resources/app-update-notices.txt` with the available original texts for all sixteen added runtime packages, including argparse's Python license and sax's Blue Oak license. lazy-val declares MIT but includes no separate license file; its exact license/source review remains open. The standard collector reports that gap explicitly.

- **Tectonic 0.17.0**: https://github.com/tectonic-typesetting/tectonic/tree/tectonic%400.17.0. The compiler and its
  components have multiple license terms; see the upstream `LICENSE`, component license files and retained source copyright headers.
- **Tectonic / TeX Live resource bundle**: https://relay.fullyjustified.net/default_bundle_v33.tar. The pinned upstream
  digest is recorded in `scripts/runtime-config.mjs`. Individual LaTeX packages and hyphenation resources retain their
  copyright/license headers and have their own terms. https://tug.org/texlive/copying.html
- **Latin Modern fonts**: https://www.gust.org.pl/projects/e-foundry/latin-modern. Distributed under the GUST Font
  License. https://www.gust.org.pl/projects/e-foundry/licenses/GUST-FONT-LICENSE.txt
- **Biber 2.17**: https://github.com/plk/biber/tree/v2.17 (Artistic License 2.0). The official macOS universal
  archive is pinned by SHA-256 in `scripts/runtime-config.mjs`; its native slice and embedded Perl dependencies
  are included. Embedded components retain their own license terms.
- **Roboto LaTeX package and fonts**: https://ctan.org/pkg/roboto (LPPL, Apache-2.0, and OFL, by component).
- **Source Sans Pro LaTeX package and fonts**: https://ctan.org/pkg/sourcesans (LPPL and OFL).
- **Font Awesome 5 Free icon fonts and LaTeX package**: https://ctan.org/pkg/fontawesome5 (OFL-1.1 fonts;
  LPPL-1.3c package).
- **PDF.js**: https://github.com/mozilla/pdf.js (Apache-2.0).
- **CodeMirror**: https://codemirror.net/ (MIT).
- **React**: https://github.com/facebook/react (MIT).
- **Lucide**: https://lucide.dev/license (ISC).
- **Manrope** interface font: https://github.com/google/fonts/tree/main/ofl/manrope (OFL-1.1).
  Bundled WOFF2 subsets from Google Fonts; license in `public/licenses/Manrope-OFL.txt`.
- **JetBrains Mono** editor font: https://www.jetbrains.com/lp/mono/ (OFL-1.1).
  Bundled regular and italic WOFF2 subsets from Google Fonts; license in `public/licenses/JetBrains-Mono-OFL.txt`.
- **Electron**: https://github.com/electron/electron (MIT and licenses of bundled Chromium/Node.js components).
- **fflate**: https://github.com/101arrowz/fflate (MIT).

Current development packages also include `Contents/Resources/tex-font-notices/`: fifteen unchanged font copyright, license, README and manifest files, plus a source guide. All 63 included compiler font binaries and 48 matching support files map exactly to retained TeX Live distributions. The collector verifies the publisher’s archive checksums; full original archives remain available at the pinned source URLs. See [font materials and verification](docs/LICENSING.md#collect-and-bundle-compiler-font-notices). This does not complete the remaining TeX/native application audit or alter the older preview-4 download.

The six resume templates are original sample content for this project. All names, organizations, achievements, and
contact details in them are illustrative.

The optional table pack is tracked separately in `resources/packs/multirow-v1/source.lock.json`.
It adds unchanged Multirow 2.9 package files (LPPL), Computer Modern font metrics (Knuth terms),
AMS Type 1 fonts (OFL), and the matching LaTeX `size12.clo` (LPPL). The one vendored size file
has its unmodified license and source provenance in `resources/packs/multirow-v1/vendor/`.
The pack release carries the complete locked upstream source/material archives and notices.
See [pack publication and key management](docs/PACK_PUBLISHING.md). This scoped pack inventory
does not replace the complete application-binary audit below.

Before distributing a compiler-bundled application binary, complete a per-component redistribution audit, ship all required license texts and
source-related materials, and generate an SBOM. This development notice is an inventory and does not replace those
release requirements.

Use `node scripts/collect-license-materials.mjs` to collect installed npm production license texts, Electron/Chromium notices and a scoped npm SBOM. The generated inventory lists missing texts and the remaining non-npm audit. See [licensing scope](docs/LICENSING.md).

Use `node scripts/collect-runtime-license-materials.mjs` for pinned Tectonic/Biber source archives, Tectonic's exact source submodules and their unmodified notice/build files. `resources/runtime-license-sources.lock.json` records provenance and digests. This is selected source material, not a completed compiler-binary redistribution audit.

Use `python3 scripts/collect-rust-license-materials.py` after that collector for all 437 registry crates in Tectonic's verified lockfile, including optional and non-Mac dependencies. Crate checksums, 770 packaged notice files and 17 exact-commit supplemental notices are recorded locally; two missing notice texts remain explicit. See [the Rust source verification record](docs/releases/rust-source-verification.json) and [scope and reproduction steps](docs/LICENSING.md#collect-locked-rust-sources-and-notices). This source inventory is not the final binary SBOM.

Use `python3 scripts/collect-native-license-materials.py` for the exact payload archives of eleven native ports from Tectonic’s verified upstream build and their 33 unmodified notice files. The lock checks the original vcpkg recipes and SHA-512 values; see [native source verification](docs/releases/native-source-verification.json). This includes build tools and potentially unused libraries, so it is not the final linked-binary SBOM or a completed redistribution audit.

The [Apple silicon Cargo audit](docs/LICENSING.md#resolve-the-apple-silicon-compiler-build-graph) matches 330 resolved package names/versions to the original compiler build. All 304 selected registry crates have checked notice texts; the two missing notices in the full lockfile are outside that build. Host tools and procedural macros remain identified as build dependencies.

Use `python3 scripts/collect-rust-standard-library.py` for the matching official Rust 1.97.1 source and Apple silicon standard-library components. It retains 79 unmodified notice files and the original archives, checks 1,161 vendored source files, and maps all 27 prebuilt `.rlib` libraries to source manifests. These libraries include compiler/test support and are not all claimed to be linked into Tectonic. See [standard-library materials and scope](docs/LICENSING.md#collect-rust-standard-library-materials). The separate historical `resources/runtime-core-v1-notices.md` remains unchanged to preserve existing compiler/pack identities.

Use `python3 scripts/collect-biber-build-evidence.py` for byte provenance of Biber's arm64 executable and all 3,979 prepared cache files, matching Biber source files, and original Perl 5.32.1, PAR 1.017 and PAR::Packer 1.055 source archives and selected notice/build materials. Additional embedded CPAN/native components and final redistribution review remain open. See [Biber evidence and scope](docs/LICENSING.md#collect-biber-payload-and-foundation-sources).
