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

## License provenance

The root LICENSE is copied without modifications from the [official PolyForm license repository at tag 1.0.0](https://github.com/polyformproject/polyform-licenses/blob/1.0.0/PolyForm-Noncommercial-1.0.0.md). The original project copyright notice is separate in NOTICE. The [PolyForm project](https://polyformproject.org/licenses/noncommercial/1.0.0) publishes the same standard terms.
