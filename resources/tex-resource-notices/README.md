# Original notices for included TeX resources

These files belong to their original authors and keep their original terms. Folio's noncommercial license does not replace them. This folder contains 102 unchanged notice, license, README, author and manifest files, plus this guide and `SOURCES.json`.

The included compiler's `runtime/bundle.zip` contains the original resource files, with their embedded copyright and license comments preserved. `SOURCES.json` identifies each matched file, its original archive path, its SHA-256 digest and the full distribution archive URL. A package's catalogue label alone does not determine the terms of each file: language patterns in particular contain individual grants, sometimes offering a choice of licenses. The supplemental full license texts do not change those grants.

402 non-font resources match retained upstream files exactly. They include LaTeX classes and packages, math and graphics support, font metrics and language hyphenation patterns. Three files match the [Tectonic bundle source at commit dfed7aa15e17b9c93bc2606020a98ef32c8da61e](https://github.com/tectonic-typesetting/tectonic-texlive-bundles/tree/dfed7aa15e17b9c93bc2606020a98ef32c8da61e): `latex.ltx`, `l3backend-xetex.def` and `tectonic-format-latex.tex`. The first two include Tectonic's upstream changes; Folio has not edited their contents. Their embedded LaTeX notices remain applicable; the repository's MIT notice is not a replacement for them.

The other matched files come from the [historical TeX Live 2021 distribution](https://ftp.math.utah.edu/pub/tex/historic/systems/texlive/2021/tlnet-final/archive/). All 245 retained TeX Live run, documentation and source archives are checked against that distribution's original package database, including its published SHA-512 checksums. The additional Tectonic source archive makes 246 full archives in the developer source collection. These are distribution matches, not proof of a rebuild from editable sources.

The separate `tex-font-notices` folder covers 111 font-family resources. Together, the two source collections map 513 of the compiler bundle's 516 resource files. The generated `kanjix.map`, `language.dat` and `pdftex.map` files still need their generation inputs and redistribution mapping reviewed. Full source distribution and the complete app's redistribution review are not finished. This folder is not a complete app SBOM or a declaration that all release obligations have been met.

To reproduce the collection, use Python 3.11 or later from the Folio source repository:

```
python3 scripts/collect-tex-resource-materials.py --write-notices
```

Add `--offline` after the original archives have been retained. The lock, reproduction steps and remaining release requirements are in `resources/tex-resource-sources.lock.json` and `docs/LICENSING.md`. Folio contributors provide support for Folio. The original TeX authors do not maintain or endorse this app.
