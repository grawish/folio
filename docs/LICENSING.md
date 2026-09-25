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

## License provenance

The root LICENSE is copied without modifications from the [official PolyForm license repository at tag 1.0.0](https://github.com/polyformproject/polyform-licenses/blob/1.0.0/PolyForm-Noncommercial-1.0.0.md). The original project copyright notice is separate in NOTICE. The [PolyForm project](https://polyformproject.org/licenses/noncommercial/1.0.0) publishes the same standard terms.
