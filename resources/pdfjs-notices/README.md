# PDF.js component notices

These files preserve original terms and attribution from PDF.js 6.3.289, published from Mozilla commit `1c8020a7d4e43668ac287a3ecf9a8dbea17e4c56`. Folio’s noncommercial terms do not replace them. The package’s main Apache 2.0 license is also included under `npm-notices/pdfjs-dist--LICENSE`.

Seven complete original license files cover the Brotli decoder and the qcms, OpenJPEG and JBIG2 helper code and upstream projects. Four files ending in `original-header.txt` are unchanged initial comment blocks from the Brotli decoder, qcms utility, Flate stream and MurmurHash implementation; they preserve Google, Mozilla, Glyph & Cog and Opera attribution.

`SOURCES.json` pins the npm archive, publisher commit, original files, exact source-map positions and the copied notice bytes. The seven inspected source files match the original publisher source maps in eight places. This associates the component sources with the publisher’s PDF.js build; it does not independently reproduce each minified component or its native codec build. Folio copies the minified worker from that same verified npm archive. Folio disables WASM and worker fetching and does not ship the codec WASM files or fallback decoder scripts.

To verify and retain the original files:

```sh
python3 scripts/collect-pdfjs-license-materials.py
# After the verified files are cached:
python3 scripts/collect-pdfjs-license-materials.py --offline
```

The collector reads the locked npm archive and downloads exact-commit source materials without installing or executing them. Full original files, the complete npm archive and reports remain under ignored `artifacts/license-materials/pdfjs/`. The Mac package gate rejects missing, changed, linked or extra notice files. This collection closes the identified PDF.js notice gaps; it does not mark the entire application’s redistribution audit or SBOM complete.
