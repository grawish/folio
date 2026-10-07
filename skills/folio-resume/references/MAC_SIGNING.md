<!-- Generated from docs/MAC_SIGNING.md; run npm run skill:build after editing the guide. -->

# Signing the Apple silicon app

Signing adds a digital stamp to an app. That stamp changes the file's bytes. Folio also keeps a fingerprint of every compiler file, so it must record those new bytes **after** signing the compiler and **before** sealing the app.

The build now follows that order. A private ad-hoc build verifies the mechanism on the development Mac. It is not a Developer ID or notarized release. The public preview-5 download is unsigned. The complete production release still needs the checks in [the release audit](RELEASE_GAP_AUDIT.md).

## What the packaging hook does

The pinned electron-builder 26 `mac.sign` hook in `scripts/sign-mac-app.mjs` receives the identity and keychain selected by the builder. Its normal notarization step remains after the hook. The public `@electron/osx-sign` API signs Electron's frameworks and outer app. See [electron-builder's version-26 macOS configuration](https://www.electron.build/v26/docs/mac/).

1. Check the private packaging copy against the complete prepared runtime inventory.
2. Find native Mach-O files by their contents, including Perl `.bundle` modules; verify their arm64 architecture.
3. Build Folio's fixed-entry Biber launcher and relocate its bundled library references.
4. Sign each native file, verify its signature, and hash its actual final bytes. Non-code resources must remain identical.
5. Write and verify the new exact runtime manifest. No signature bytes are ignored or normalized.
6. Compile the app-owned resume, font and bibliography fixture using the application's unchanged offline macOS sandbox. A signature that passes but breaks Biber cannot pass this gate.
7. Seal the outer app without re-signing the already measured runtime; verify the app and runtime again. Keep `runtime-signing.json` next to the app, outside its seal.

A failed operation invalidates that private staging copy. Rebuild from the original prepared runtime; do not repair the failed copy's manifest to make it pass. Signing inside-out follows [Apple's code-signing guidance](https://developer.apple.com/library/archive/technotes/tn2206/). Native tools currently remain within the runtime resource directory; this is not a claim that their bundle placement is Apple's preferred layout.

## Why Biber needs a different launcher

The original Biber executable contains another interpreter and compressed libraries. PAR checks the cached interpreter's size. Signing changes it, so the old launcher extracts another interpreter into the writable job directory. Folio's sandbox correctly rejects executing that newly extracted file. The first private signing attempt reproduced this failure.

`scripts/biber-launcher.c` loads the already bundled Perl library and runs only `biber-cache/inc/script/biber-darwin`. It clears Perl startup overrides, restricts Perl's module search to the bundled directory, and passes user arguments to Biber. It does not accept a different Perl script. The original Biber scripts, data and Perl modules stay byte-for-byte unchanged.

The launcher uses the public embedding calls from the pinned threaded Perl 5.32.1 ABI. Its opaque declarations were checked against that release's `proto.h` and `perl.h`; packaging requires the exact reviewed original Biber and `libperl.dylib` hashes in `resources/biber-build-provenance.lock.json`. This is not a general launcher for arbitrary Perl versions. See [Perl's embedding documentation](https://perldoc.perl.org/5.32.1/perlembed).

Bundled native imports use relative `@loader_path` references so loading does not depend on a development machine's `/opt/local` or `DYLD_LIBRARY_PATH`. Two optional upstream modules retain unavailable MySQL/X11 imports; the signing record lists them. They are not exercised by the resume/bibliography corpus. Broader native dependency and redistribution review remains open. Folio's process, file, network and time limits are unchanged.

## Try the private signing test

Use an Apple silicon development Mac with Xcode Command Line Tools and the prepared runtime:

```sh
npm ci
npm run setup
npm run build
FOLIO_ADHOC_SIGNING_TEST=1 CSC_IDENTITY_AUTO_DISCOVERY=false \
  npx electron-builder --mac --arm64 --publish never \
  -c.mac.identity=- -c.mac.hardenedRuntime=false -c.mac.notarize=false \
  -c.directories.output=release/runtime-signing-test
node scripts/verify-mac-package.mjs release/runtime-signing-test --allow-ad-hoc-test
node scripts/test-packaged.mjs release/runtime-signing-test/mac-arm64/Folio.app/Contents/MacOS/Folio
```

The explicit test switches are required. Ordinary artifact verification rejects an ad-hoc candidate. Do not publish these files as an authenticated release. The test deliberately lacks Developer ID, secure timestamps, notarization and hardened-runtime acceptance.

The source tests include real Apple signatures and changed-file/forged-record controls. `npm run test:integration` includes a private signed runtime, a path containing spaces, startup-override rejection and actual offline PDF rendering. Build artifacts, expanded runtimes and test profiles remain ignored by Git.

## Verify a distribution candidate

Use the owner's Developer ID and notarization credentials through the builder's supported setup. Do not put secrets in source, documents or chat. Leave the production hardened-runtime and timestamp requirements enabled. Set the independently chosen, ten-character `FOLIO_APPLE_TEAM_ID`, then qualify the final app and use the explicit production check:

```sh
npm run dist -- --publish never -c.mac.notarize=true \
  -c.dmg.sign=true -c.dmg.writeUpdateInfo=false \
  -c.directories.output=release/production-candidate
npm run release:finalize-dmg -- release/production-candidate
node scripts/test-mac-release.mjs release/production-candidate
node scripts/verify-mac-package.mjs release/production-candidate --distribution
```

The verifier checks the real outer signature and every native runtime signature against the expected identifier, Apple Developer ID certificate requirement and owner-selected Team ID. It also requires hardened runtime and a secure timestamp. It checks the original runtime, final runtime, complete code list, resource bytes and launcher source record independently; `passed: true` in a sidecar is insufficient. Apple's [code-signing requirements note](https://developer.apple.com/documentation/technotes/tn3127-inside-code-signing-requirements) describes certificate and identity requirements.

Native qualification now records the complete app inventory hash, covering regular-file bytes, modes and internal symbolic links, before and after each suite. Resume and final artifact verification require the same inventory. This prevents results for an unsigned compiler from qualifying a different signed compiler with an identical `app.asar`. Extended attributes and ACLs are outside this inventory.

The package verifier now compares the app inside **both** the DMG and ZIP with that same app inventory. It streams ZIP members before private extraction, checks complete decompression output, and rejects changed/omitted/duplicate entries, unsafe paths, changed links or permissions, and unexpected members. Bounded AppleDouble metadata is allowed only alongside expected app entries. It then uses macOS `ditto` to extract and re-inventories the result. The DMG mounts read-only at a private location and is detached before cleanup; an unsuccessful detach preserves the temporary folder instead of deleting through a mount. Archive hashes are checked before and after, and the checksum file now includes the ZIP.

`--distribution` also requires a complete native qualification record for this exact app and verified Developer ID signatures. Both archived copies must pass `stapler validate` and `syspolicy_check distribution`; the DMG must pass its own Developer ID, staple and `spctl` checks. The expected publisher is checked against the owner's Team ID. There is no ad-hoc override for production mode. The standalone signature subreport retains `notarizationVerified: false` because that subcheck does not assess notarization; successful production acceptance is reported separately under `archives` and `distributionVerified`.

The archive checker uses Python 3's standard library as a developer dependency (`FOLIO_PYTHON` may select the test virtual environment). End users do not need Python. A new verification attempt writes `passed: false` before checking, so a failed rerun cannot leave an old success report as current evidence. Keep the process exit status and current report together; archive previous evidence before rerunning if it must be retained.

These gates are implemented, but successful production acceptance still requires the owner's signing credentials and real notarized artifacts. The pinned builder notarizes/staples the app and signs the DMG when `dmg.sign=true`; its DMG target does not separately submit or staple that disk image. The new `release:finalize-dmg` command performs this last step. Generate final checksums and signed update metadata **after** it succeeds. Do not pass the gate with a private test signature or change a verified archive afterward.

Command-line checks do not replace installing a quarantined download on a fresh supported Mac and testing offline launch, relocation, upgrades and recovery. Apple's [testing procedure](https://developer.apple.com/forums/thread/130560) and [trusted-execution guide](https://developer.apple.com/forums/thread/706442) explain the difference. Full supported-Mac, updater and license/source/SBOM acceptance remain open. See [archive verification evidence](https://github.com/grawish/folio/blob/main/docs/releases/mac-archives-verification.json) for the tested scope and negative controls.

## Finalize and resume DMG notarization

Set `FOLIO_APPLE_TEAM_ID` to the independently chosen publisher Team ID. Configure the builder's Developer ID identity and set `APPLE_KEYCHAIN_PROFILE` to an existing notarytool credential profile. `APPLE_KEYCHAIN` can select its keychain. Credentials stay in Keychain; this command does not accept a password or private key in an argument. Follow [Apple's notarization workflow](https://developer.apple.com/documentation/security/customizing-the-notarization-workflow) when setting up that profile. Build into a fresh output directory before starting finalization.

`npm run release:finalize-dmg -- RELEASE_DIR` requires the already signed, timestamped DMG, the signed/notarized app and its matching ZIP. It verifies the publisher and compares both archive app copies before uploading anything. It then saves the DMG hash, app identity, ZIP hash and Apple submission ID in `dmg-notarization-state.json`. The command requires a regular DMG with no symbolic or hard links.

A normal run waits at most 60 seconds for Apple's processing, then checks the same job again. Exit code **2** means Apple still reports **In Progress**. Keep the directory unchanged and rerun the same finalization command later. It resumes the saved job instead of submitting another copy. Do not rebuild the pending candidate or erase its state file.

If the upload was interrupted before its ID was saved, the next run stops. Inspect Apple notarization history using the configured profile, then pass the identified UUID with `--submission-id UUID`. The command will still require Apple's accepted log to name that job and the exact saved DMG SHA-256. An unknown job, rejection or different checksum cannot authorize stapling.

After acceptance, the command staples the ticket and independently runs the production archive checks: Developer ID, secure timestamps, notarization tickets, Apple policy and exact app copies inside both DMG and ZIP. An interruption after stapling can resume the same job. A completed rerun rechecks the current final bytes; it does not resubmit or staple again. The app and ZIP must remain unchanged throughout.

A lock prevents concurrent finalizers. Normal failures release it. A killed process can leave `dmg-notarization.lock`; inspect its recorded PID and remove only that lock after confirming that the process has ended. Preserve the state and artifacts so the next command can resume safely.

The finalizer invalidates any previous `verification.json` and does not write release checksums. Run the full native qualification and `verify-mac-package.mjs --distribution` afterward; that command creates `SHA256SUMS` from the final archives. Use a fresh build directory and `dmg.writeUpdateInfo=false` so there is no obsolete DMG blockmap to publish after stapling. Folio's authenticated update manifest uses the separately verified full ZIP.

Eight source tests exercise success ordering, timeout/resume, an ambiguous upload, wrong/rejected Apple results, changed artifacts, failure after stapling, corrupt state and linked files. Apple service responses are simulated. The archive suite also uses actual macOS tools to reject an unsigned DMG. These checks do not prove a successful Apple notarization or a downloaded production install. See [finalization verification](https://github.com/grawish/folio/blob/main/docs/releases/dmg-finalization-verification.json).

## Existing projects and resource packs

Signing creates a new exact compiler identity. Existing projects retain their old recorded identity and managed compiler copy. They move only through the existing backed-up [compiler comparison and Apply flow](https://github.com/grawish/folio/blob/main/docs/COMPILER_MIGRATION.md).

The current public table pack targets the original unsigned base. A distribution release must build and authenticate a pack/catalog entry for the **actual final signed base**, then pass download, installation, preview, Apply and restart acceptance. Do not relabel the old pack or accept it against a different base. Secure timestamp differences may produce different runtime identities between signed builds, so prepare packs from the final artifact, not an assumed future rebuild.

The publisher verifier now accepts that exact runtime as its optional second argument: `node --import tsx scripts/verify-published-pack.ts publication-directory final-app/Contents/Resources/runtime`. It checks the selected base before native compilation and again after the offline corpus. The [publisher guide](https://github.com/grawish/folio/blob/main/docs/PACK_PUBLISHING.md) explains the matching builder input and separate publication identity.

The private integration check builds a resource pack for an actually signed base, rejects a pack for the unsigned base, installs and reopens the matching target, and checks all 158 native files for identical bytes and valid signatures. The reopened target builds an offline resume/font/bibliography PDF with the added resource; the base remains unchanged and cannot use that added resource. This uses an ephemeral pack key and ad-hoc Apple signatures. It verifies the core installation/restart behavior, not a published catalog, native Settings workflow or Developer ID release. See [signed-base pack verification](https://github.com/grawish/folio/blob/main/docs/releases/signed-base-pack-verification.json).

Exact local evidence is recorded in [runtime signing verification](https://github.com/grawish/folio/blob/main/docs/releases/runtime-signing-verification.json). The preceding unsigned history release is separately qualified in [the hosted history record](https://github.com/grawish/folio/blob/main/docs/releases/mac-history-storage-verification.json).
