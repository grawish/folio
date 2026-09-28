# Original bibliography-helper notices

Biber helps Folio build bibliographies. New development packages now include the original license and declaration documents collected for Biber and its dependencies. This addition does not change the older preview-4 download.

To read them, right-click **Folio.app** in Finder, choose **Show Package Contents**, then open **Contents → Resources → biber-notices → README.md**. The guide links each component and original filename to its unchanged text. `SOURCES.json` records the original source locations and checksums. These tools keep their own terms; Folio's noncommercial license does not replace them.

## Included documents

| Collection | Coverage |
| --- | --- |
| Biber | Biber 2.17 README and build declaration, plus the complete Artistic 2.0 text from the pinned SPDX source |
| Perl and packagers | Original notices from Perl 5.32.1, PAR 1.017 and PAR::Packer 1.055, including selected nested notices |
| CPAN | Notices, complete reviewed source modules and root READMEs from 123 source distributions |
| Native libraries | Notice and declaration documents from nine original source archives associated with the inspected Biber libraries |

The collector verifies 136 original archives. Its 441 document references map to 414 distinct texts totaling 6,453,696 bytes. The package adds those texts, a guide and an index: 416 files in one directory. Identical bytes are stored once.

Forty-four CPAN distributions have no separate notice file in the collected set. Their complete reviewed source modules remain included so embedded license statements are preserved. A README or source module can contain more than its license paragraph; the collector does not rewrite or extract fragments from it.

This collection preserves material for review. It does not settle Biber's differing README and Build.PL license declarations, prove exact native vendor builds or patches, identify libbtparse's source version, resolve optional external-library references, or complete corresponding-source obligations and the final app SBOM. Some original source sets contain build tools or unused code. See [the licensing guide](LICENSING.md) for those explicit limits.

## Reproduce and package

First collect the Biber foundation, CPAN and native-library materials using the licensing guide. Then run:

```sh
python3 scripts/collect-biber-notices.py --materials /path/to/artifacts/license-materials
node --import tsx --test tests/biber-notices.test.ts tests/tectonic-notices.test.ts
npm run pack
```

The collector reads the retained sources without changing them, making downloads, or executing upstream code. It checks the original archive and selected member bytes against the locks and published evidence, then writes an immutable result under `artifacts/license-materials/biber-notices/`.

The reviewed `resources/biber-notices/` directory keeps the index, guide and losslessly compressed originals. The packaging hook expands them offline. Biber and Tectonic share a packaging guard with separate compiler identities and source locks. The guard validates every original text, compressed and expanded size/hash, canonical base64, safe output names and exact installed file set. It rejects linked files and damaged sources before replacing generated output.

Three Biber controls cover the full original documents, all 44 distributions without standalone notices, wrong helper identities/source locks, damaged input preservation and altered/missing/linked package files. The five existing Tectonic controls still pass after sharing the implementation. Exact local results are recorded in [verification](releases/biber-notices-verification.json); the subsequent [full hosted qualification](releases/mac-biber-notices-hosted.json) at `db6221a` passes all 460 source tests, 19 compiler integrations, twelve unchanged template images, all twenty-one native suites and the final app/archive gates. All 169 retained evidence files, exact source/app/runtime identities, original notice documents, JavaScript replay and publisher materials were independently verified. Production release requirements remain open.
