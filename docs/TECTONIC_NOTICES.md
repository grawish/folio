# Original compiler license texts

Builds from preview 5 onward include the original license and notice texts collected for Tectonic, Folio's PDF compiler. The older preview-4 download does not include them.

To find them in a built Mac app, right-click **Folio.app** in Finder, choose **Show Package Contents**, and open **Contents → Resources → tectonic-notices → README.md**. The guide maps each source component and original filename to its text. `SOURCES.json` records source URLs and checksums. Each third-party text keeps its original terms; Folio's noncommercial license applies to Folio's original work.

## What is included

| Collection | Coverage |
| --- | --- |
| Compiler sources | Tectonic 0.17.0, its reference-source submodule and pinned HarfBuzz submodule |
| Rust packages | 303 registry packages in the resolved Tectonic executable build closure, including host/build dependencies |
| Rust toolchain | Original notices in the matching Rust 1.97.1 source and Apple silicon standard-library distributions |
| Native build ports | Eleven source archives used by the upstream build; this set includes build tools and potentially unused libraries |

There are 657 source references to 255 distinct original texts, totaling 921,303 bytes. Identical text is stored once, and every source reference remains in the index. The app adds those texts, the source index and the guide: 257 files in one new directory.

This is a notice collection with explicit build/toolchain supersets. It does not assert that every listed component is linked into the executable or finish the full app SBOM. Biber/Perl, individual source grants, corresponding-source publication, production signing and remaining redistribution review are still open. See [licensing scope](LICENSING.md).

## Reproduce the originals

First collect the compiler sources, Rust sources/build graph, standard-library materials and native source materials using the commands in the licensing guide. Then run:

```sh
python3 scripts/collect-tectonic-notices.py --materials /path/to/artifacts/license-materials
```

The collector reads these inputs without changing them, downloading new files or running upstream code. It checks all 319 original archives, source members, retained notice bytes and exact-commit supplemental notices. It also checks the published Rust graph evidence. It writes an immutable, content-addressed result under `artifacts/license-materials/tectonic-notices/`.

The reviewed `resources/tectonic-notices/` directory keeps an exact source index, a readable guide and losslessly compressed original bytes. The normal packaging hook expands the original files before Electron Builder copies resources. Packaging needs no extra download or Rust toolchain.

The guard binds the collection to the compiler's pinned version, source commit and binary hash, and to four source locks. It checks compressed and expanded bytes, canonical base64, every individual text hash and the exact file set. It rejects missing, changed, linked or extra output and invalid paths or sizes. A damaged source fails before replacing the generated output.

## Verification and limits

```sh
node --import tsx --test tests/tectonic-notices.test.ts
npm run pack
```

Five focused controls cover exact original expansion, repeatability, missing/changed/linked/extra files, compiler/source-lock mismatch, invalid paths and expansion limits, and altered text even when the outer payload hashes are updated. The full source suite, type checking and final local package checks are recorded in [verification](releases/tectonic-notices-verification.json).

The package verifier checks these files alongside the existing Electron, npm, PDF.js, font and TeX notices. It does not turn a partial material inventory into a completed license review. The runtime bytes and all compiled app outputs remain unchanged by this packaging addition. After merging the qualified cache change, all 457 source tests and the [combined local package checks](releases/tectonic-notices-combined-verification.json) pass. All 39 compiled outputs match the qualified cache app; all 257 new notice files and the unchanged runtime are independently checked. Full [hosted qualification](releases/mac-tectonic-notices-hosted.json) at `3bd4a88` now passes 457 source tests, 19 compiler integrations, twelve unchanged template images, all twenty-one native suites and the final app/archive gates. All 169 downloaded evidence files, exact source/app/runtime identities, original notice bytes and JavaScript publisher materials were independently checked. Production release requirements remain open.
