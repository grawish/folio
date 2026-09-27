# Inventory the packaged Mac app

Folio can now produce a file inventory and a CycloneDX record from an actual `Folio.app`. This ties later component and license review to the bytes in a particular package. The record explicitly declares its component coverage incomplete: listing files does not finish the redistribution audit or establish that an app is signed and notarized.

## Run the tool

After installing the normal developer dependencies, run this on macOS:

```sh
node --import tsx scripts/inventory-mac-app.ts /absolute/path/to/Folio.app
```

The tool reads the app and writes three files beneath `artifacts/license-materials/mac-app/<inventory hash>/`. It does not launch or change the app. The selected bundle must identify itself as Folio, contain an Apple silicon main executable and have a matching Apple silicon runtime manifest.

- `bundle-inventory.json` records each physical file's SHA-256, logical size and POSIX mode, every directory, and each internal symbolic link's written and resolved target.
- `bundle.cdx.json` expresses files and links as a nested application assembly, links back to the inventory hash, and sets its composition to **incomplete**. It does not invent component licenses or dependency edges.
- `summary.json` identifies the app, its app.asar and runtime-manifest hashes, counts, record hashes and unresolved scope.

Links must resolve inside the bundle. Absolute, escaping and broken links are rejected. Pipes and other special files are rejected without reading them. File descriptors are checked before and after hashing, and a second metadata traversal checks for ordinary changes during the scan. Inputs are bounded to 20,000 entries, 2 GiB per file and 4 GiB of regular-file content. This is not an atomic snapshot or a sandbox against a hostile process changing paths concurrently.

Validation is offline using the unmodified [CycloneDX 1.6 schemas](https://github.com/CycloneDX/specification/tree/55343ba19dee1785acf1ce9191540d5fd7b590db/schema), pinned to an exact upstream commit and checked by digest. The compressed schemas and their original Apache 2.0 license are in `resources/sbom-schema/`. Pinned Ajv and format validators are developer dependencies. They and the schema data are outside the application's bundled runtime inputs.

Future **Qualify Apple silicon candidate** runs inventory the exact app after all native/package gates pass and retain these records with their evidence artifact. Existing queued runs use the workflow revision at their original commit.

## Recorded development package

The first scan uses the local workspace-queue package from source `cb6792f`, with app.asar SHA-256 `57acc51c137af76e038665a3149e68556ac4e475ad73919c51b6685b0610fb34`. It records **4,241 regular files, 761 directories and 14 internal links**, totaling **679,287,682 logical file bytes**. All **3,982 runtime-manifest file hashes** match. The total is a sum of file lengths, not unique allocated disk space.

Repeated runs produce identical records. A separate Python traversal checks every path, mode, file hash and link, recomputes counts/bytes, and verifies all 4,255 file/link mappings in the CycloneDX record. The five focused controls pass, including schema rejection of a damaged hash and an invalid timestamp. All 261 source tests, the build and formatting checks pass. The tooling leaves all 39 compiled application outputs and every packaged package.json field identical to this package.

Download the [compressed inventory](releases/mac-app-inventory/bundle-inventory.json.gz), [compressed CycloneDX record](releases/mac-app-inventory/bundle.cdx.json.gz), [summary](releases/mac-app-inventory/summary.json), and [verification](releases/mac-app-inventory-verification.json). Gzip round trips and all published hashes have been checked. These records describe this development package, not the older downloadable preview or a future signed build.

## Work still required

The physical inventory must still be connected to the contents of ASAR/ZIP/PAR archives, linked native code, component versions and source/license obligations. Existing [source and license evidence](LICENSING.md) provides inputs for that work. The current record does not inherit Folio's noncommercial terms onto third-party files.

Extended attributes, ACLs, resource forks, code-signature/notarization validity and DMG contents are outside this inventory. Re-run it for the final signed app and verify the actual distribution artifact separately. Schema validity and matching hashes do not by themselves prove complete SBOM or license coverage.

## Reproduce and attribute application JavaScript

Use the exact source checkout and installed locked dependencies that produced the app:

```sh
node scripts/inventory-javascript.mjs /absolute/path/to/Folio.app
python3 scripts/collect-npm-license-materials.py
python3 scripts/verify-javascript-sources.py
```

The first command replays esbuild and Vite in memory with disk writes disabled. Every emitted output must match the selected app’s bytes. Every JavaScript file and distributed source map in `app.asar` must be covered. Changed output, omitted files, unknown generated helper IDs and unresolved static imports fail the check. Known Node/Electron imports are listed separately. The selected app is read, not launched or changed.

Records go under `artifacts/license-materials/javascript/<inventory hash>/`: `inventory.json` has source/contribution hashes, package lock identities, original source-map locations and exact output hashes; `javascript.cdx.json` is a schema-validated CycloneDX 1.6 record; `summary.json` has counts and record hashes. `test-results/javascript-inventory-location.json` identifies the last successful output. A failed replay exits unsuccessfully and does not make an older record current evidence.

The collector retains the full locked npm archives and original notices. Use `--offline` after the verified archives are cached. The final command verifies every contributing package’s metadata and source bytes against those archives and writes `publisher-sources.json` beside the inventory. Sources embedded in publisher maps must match the exact map path, digest, source index and text. Missing original notices remain disclosed in the source index; a declared license is not proof of complete license compliance.

The local [verification record](releases/javascript-bundle-verification.json) covers eight packaged JavaScript/maps and 24 reproduced outputs: 402 modules from 35 contributing npm packages, three build tools and Folio’s own sources. It detects `has-flag` and `supports-color` despite their npm development flags. Three generated helpers are associated with reviewed Vite/Rolldown generator IDs; this does not assign every helper byte to an individual author. The added notices bring the packaged collection to 42 originals from 43 indexed packages. The broader notice collection deliberately includes optional or potentially unused packages.

The exact [contribution inventory](releases/javascript-bundle-inventory.json.gz), [CycloneDX record](releases/javascript-bundle.cdx.json.gz) and [publisher-source checks](releases/javascript-publisher-sources.json.gz) are published as small gzip files; their compressed and uncompressed hashes are in the verification record.

Future Mac qualification runs execute these checks after native and package gates and retain the reports with the evidence artifact. These are application-JavaScript records, not a complete binary SBOM: nested vendored components, dynamic discovery, native/compiler/TeX materials, Electron/Chromium and full redistribution remain separate. The generator executes the repository’s trusted build configuration and is not a sandbox for untrusted projects or an atomic filesystem snapshot.

## PDF.js component source and notice associations

The application JavaScript record traces `pdfjs-dist` to the exact publisher archive. The [PDF.js component collector](LICENSING.md#preserve-pdfjs-component-notices) adds original source-map associations for Brotli and the qcms, OpenJPEG and JBIG2 helpers, plus the Flate stream and MurmurHash copyright headers. It retains the original inputs and binds the added packaged notices by SHA-256. These associations do not by themselves subdivide the minified worker into byte-exact component boundaries; the application CycloneDX composition remains incomplete.
