# JavaScript dependency notices

The other text files in this directory are unchanged originals from the npm publisher archives pinned in `SOURCES.json`. Package names, versions, exact archive URLs, npm SHA-512 integrity values and file SHA-256 digests are recorded there. These third-party works retain their own licenses; Folio's noncommercial license does not replace them.

This collection covers 43 packages: 38 installed production packages on Apple silicon, including optional or potentially unused packages, plus five packages involved in reproduced application JavaScript or its generated support code. It preserves 42 original notice/license files. The additional packages are has-flag and supports-color (bundled code), and esbuild, Vite and Rolldown (build support). Rolldown’s original third-party notice is included. The packaged-byte inventory records actual contributions separately; this collection does not assert that every listed package is linked into the final app. Electron and Chromium supply separate notices; compiler, TeX, font and native dependencies are audited separately.

Two packages have no separate original notice file in their published archive: `lazy-val` 1.0.5 declares MIT, and `@napi-rs/canvas-darwin-arm64` 1.0.9 declares MIT. Their declarations and source archives are recorded without inventing an upstream copyright notice. The complete binary attribution and redistribution review remain open.

Reproduce and verify the original archives and texts from a Folio source checkout:

```sh
python3 scripts/collect-npm-license-materials.py
# Use retained archives without network access:
python3 scripts/collect-npm-license-materials.py --offline
```

The collector only reads archive members. It does not install packages or execute their code. It keeps the complete locked publisher archives under `artifacts/license-materials/npm/archives/` and original texts under `notices/`. These ignored developer artifacts are separate from the notices bundled in the app. The package verifier checks this entire directory, including this guide and the source index, against the reviewed source.
