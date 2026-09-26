# Folio table resources — preview 1

This optional resource pack adds **Multirow 2.9**, **bigstrut** and **bigdelim** for table cells, row spacing and braces. It includes unchanged supporting font resources and the matching LaTeX 12-point size file. It does not contain a compiler executable or a Folio installer.

It requires Folio's exact Apple silicon core compiler with identity `67627693e8bc1d0b237459517c50b661a72b33f3cb93ad08ff0fb07259a0b059` (Tectonic 0.17.0, Biber 2.17, `folio-core-v1`). A similar version label is not sufficient. The supplied table corpus covers A4 and US Letter at 10, 11 and 12 points; this does not promise support for every imported document or third-party package.

In a Folio build with the publisher configured, open **Settings → LaTeX resources**, check for packs, then download and install. You can also import the `.foliopack` file for offline transfer. Read its notices, wait for compiler checks, and use **Preview for this project** before choosing **Use this pack**. Installation itself leaves the project's compiler selection unchanged. See [the walkthrough](https://github.com/grawish/folio/blob/main/docs/tutorials/resource-packs.md).

The `.foliopack` has a pinned Ed25519 publisher signature. Folio verifies its bytes, assembles a separate runtime and runs offline compiler checks before accepting it. `SHA256SUMS` is an additional transport check, not a replacement for signature verification.

The accompanying source/material archives are unmodified upstream copies. `SOURCE.json` records their origins and hashes, while `NOTICES.txt` preserves attribution and the separate LPPL, OFL and Knuth terms. Those third-party resources retain their own licenses. Original Folio integration code and documentation remain under PolyForm Noncommercial 1.0.0.

The signed/notarized Mac installer, automatic app updates, wider macOS acceptance and complete application-binary licensing audit remain separate release requirements. This resource-pack preview does not claim those are finished.
