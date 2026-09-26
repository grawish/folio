# Third-party resources — development preview

Folio's dependency versions are recorded in `package-lock.json`. Dependency packages retain their own license files. The
LaTeX resource inventory and SHA-256 hashes are recorded in `resources/bundle.lock.json` and copied into each prepared
runtime.

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
