# Folio Mac icon

The Mac application uses the existing mark from `website/favicon.svg`: a pale “f” and cyan dot on a navy rounded square. This is original Folio artwork, covered by the repository’s `LICENSE` and `NOTICE`.

`folio.icns` contains the standard 16, 32, 128, 256 and 512-point Mac images at 1× and 2× resolution. `folio-1024.png` is the largest rendition for review. The SVG is rendered independently at each unique pixel size; the small favicon is never enlarged.

To regenerate on macOS, run `npm run icon:build`. It uses the system SVG renderer (`sips`) and `iconutil`, with no downloads or added build dependencies. The SVG’s generic sans-serif font is resolved by macOS; review the regenerated image when the OS renderer or font changes. Normal packaging uses these committed files and does not regenerate them.

`build.mac.icon` in `package.json` selects the icon. The Mac package verifier checks `CFBundleIconFile` and compares the installed icon byte for byte with the reviewed file. The icon also participates in the existing full-app inventory, archive comparison and signing checks.
