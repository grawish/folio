# Publishing resource packs

Packs are optional resources for the included Apple silicon compiler. They do not replace native executables, fetch packages during compilation, or change a project's compiler without a PDF preview and explicit Apply.

## Publisher identity

`resources/pack-publisher.json` contains only public verification keys, approved HTTPS hosts and the catalog URL. The first key is `folio-packs-2026-09`; its SHA-256 SPKI fingerprint is `d55a81e602bb1c5d68fddc32207f1ba8dcfe94ce69da494b6fd23b291499bc01`.

The private key is outside the repository in the owner's private `~/Library/Application Support/Folio Publisher/pack-signing-2026-09.pem` file. The directory is mode 0700 and the key is mode 0600. Neither a private key nor a runtime trust override belongs in the app, source repository, tutorial screenshots or release assets. This publisher signature is separate from Apple's Developer ID signing and notarization.

The catalog-renewal workflow uses the repository secret `FOLIO_PACK_SIGNING_KEY`. The workflow exposes the secret only to its renewal step and runs on the main branch. That step writes a private temporary file, unsets the environment variable, removes the file on exit and prints only public catalog metadata. The repository owner should keep a separate protected recovery copy; an encrypted GitHub secret cannot be read back as a backup.

## Build and verify the first pack

The first recipe is `resources/packs/multirow-v1/`. Its source lock pins Multirow 2.9 at upstream revision `ffd9f3f0238449be9239a05904e72ab3475139e6`, the LPPL text and the Computer Modern/AMS font resources and matching LaTeX 12-point size file required by the offline table corpus. The builder copies unchanged bytes and verifies every selected member against its digest. It reads archive members without extracting or running upstream code.

```sh
node --import tsx scripts/build-published-pack.ts \
  resources/packs/multirow-v1 resources/runtime/mac-arm64 \
  "$HOME/Library/Application Support/Folio Publisher/pack-signing-2026-09.pem" \
  artifacts/resource-packs-v1 --offline
node --import tsx scripts/verify-published-pack.ts artifacts/resource-packs-v1
```

Omit `--offline` only when retrieving reviewed pinned inputs. A release mirror can preserve the same source bytes after an upstream archive changes. It must still match the original locked digest. The builder refuses an existing output directory. Keep a failed candidate separately, then use a new output directory; do not overwrite a published archive.

The local verifier checks A4 and US Letter at 10, 11 and 12 points. The output includes the signed `.foliopack`, complete upstream source/material archives, unmodified license texts, combined notices, a source inventory, publication metadata and checksums. The pack contains no compiler executable. Multirow retains LPPL terms; Computer Modern metric resources retain Knuth's naming requirements, the AMS Type 1 fonts retain OFL terms, and the unchanged `size12.clo` retains LPPL terms with the complete matching LaTeX source archive. The original Folio integration code remains noncommercial. These scopes are recorded separately in the notices; the complete application binary audit remains a separate requirement.

Review the offline probe and source/material checks before publishing a pack release. Upload only the generated files for that reviewed candidate, never the containing general `artifacts/` directory. Record the exact source commit, pack hash and target compiler identity. Copy the verified `publication.json` to `resources/packs/published.json` only for the assets actually published.

## Renew the catalog

```sh
node --import tsx scripts/refresh-pack-catalog.ts \
  "$HOME/Library/Application Support/Folio Publisher/pack-signing-2026-09.pem" --check
```

The command authenticates the previous catalog even when expired, increments its sequence, validates the candidate with the application's verifier, then downloads and checks every pack and accompanying source/material asset. It reauthenticates each signed pack and requires its metadata to match the catalog entry. A wrong key, changed asset, unapproved redirect, missing source material or changed local inputs prevents publication. Remove `--check` to write `resources/packs/catalog.json` atomically. Commit that one file after reviewing the public sequence and expiry.

Catalogs last 45 days. `.github/workflows/pack-catalog.yml` renews them on the 1st and 15th of each month and can also run manually. It commits only the signed catalog. Non-fast-forward pushes fail instead of overwriting newer work. The app fetches that small file over HTTPS from the repository's raw-content host; GitHub Pages deployment is not required for renewal. Repository administrators must keep scheduled workflows enabled and check failed runs. If renewal stops, expired metadata cannot authorize new downloads; retained valid signed packs remain usable offline.

## Rotate or retire a key

1. Generate a new private key outside the repository and add only its public key under a new ID. Update the recipe and signing secret. Review the public fingerprint through the release process.
2. Re-sign the unchanged approved pack contents with the new key, publish new immutable asset URLs and update the publication inventory. A key change must not silently alter source/resources or project pins.
3. Keep the old public key in the native configuration, but put its ID in `retiredKeys`. This permits signature checks of old catalog metadata solely to preserve the stored sequence and clean its cache. It cannot authorize a new catalog, download, import or archive-based repair.
4. Publish a newer catalog with the active key and ship the updated app trust configuration. Raise `minimumSequence` when appropriate. Test a profile containing the previous catalog and retained archive as well as a fresh profile.

Revocation reaches users through an app update; an offline old app cannot learn that a key was compromised. Already installed immutable compilers continue to be checked by their recorded file hashes. A project keeps its exact pin; replacing a retained archive requires a newly accepted signature and explicit user actions. A compromised-key incident also requires reviewing the affected artifacts and release history; do not represent ordinary catalog expiry as complete revocation.

## Verification scope

Protocol tests cover retired-key refusal, migration from a cached old-key catalog without resetting its rollback floor, pack/source hash mismatches, archive metadata mismatch, wrong signing keys, sequence renewal and restricted/bounded publication downloads. Real offline compilation and the final source/native/package checks are separate evidence. A catalog signature and a passing synthetic test do not by themselves establish redistributability, compatibility or completion of the signed Mac release.
