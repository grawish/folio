# Original Electron and Chromium notices

This folder preserves the complete `LICENSE` and `LICENSES.chromium.html` from the official Electron **44.4.5 darwin-arm64** release ZIP. The `.gz` files are lossless storage copies, not edited or abbreviated notices. `SOURCES.json` records compressed and original hashes and the release archive identity.

The publisher's release asset digest, `SHASUMS256.txt`, and the checksum entry inside the npm archive pinned by Folio's lockfile agree on the original ZIP. The installed framework and both installed notices were compared byte for byte with that ZIP. Original Electron and Chromium component terms apply to their own work; Folio's noncommercial license does not replace them.

The packaging hook expands and validates both notices offline, then copies the complete readable files, this guide and `SOURCES.json` into `Folio.app/Contents/Resources/electron-notices/`. `scripts/verify-mac-package.mjs` rejects missing, changed, linked or unexpected files. The full Chromium notice file is about 20 MB; its compressed source copy is about 2 MB.

Upstream: https://github.com/electron/electron/releases/tag/v44.4.5

This preserves upstream notices. It does not independently rebuild Electron/Chromium, finish their source-obligation review or complete the Folio binary SBOM. A dependency upgrade requires reviewing the corresponding upstream release and refreshing both copies and the index together.
