# Signing the Apple silicon app

Signing adds a digital stamp to an app. That stamp changes the file's bytes. Folio also keeps a fingerprint of every compiler file, so it must record those new bytes **after** signing the compiler and **before** sealing the app.

The build now follows that order. A private ad-hoc build verifies the mechanism on the development Mac. It is not a Developer ID or notarized release. The public preview-4 download is unchanged. The complete production release still needs the checks in [the release audit](RELEASE_GAP_AUDIT.md).

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

Use the owner's Developer ID and notarization credentials through the builder's supported setup. Do not put secrets in source, documents or chat. Leave the production hardened-runtime and timestamp requirements enabled. Then set the independently chosen, ten-character `FOLIO_APPLE_TEAM_ID` when running `scripts/verify-mac-package.mjs`.

The verifier checks the real outer signature and every native runtime signature against the expected identifier, Apple Developer ID certificate requirement and owner-selected Team ID. It also requires hardened runtime and a secure timestamp. It checks the original runtime, final runtime, complete code list, resource bytes and launcher source record independently; `passed: true` in a sidecar is insufficient. Apple's [code-signing requirements note](https://developer.apple.com/documentation/technotes/tn3127-inside-code-signing-requirements) describes certificate and identity requirements.

Native qualification now records the complete app inventory hash, covering regular-file bytes, modes and internal symbolic links, before and after each suite. Resume and final artifact verification require the same inventory. This prevents results for an unsigned compiler from qualifying a different signed compiler with an identical `app.asar`. Extended attributes and ACLs are outside this inventory.

`notarizationVerified: false` remains explicit in this verifier. Before production publication, add and pass actual notarization/stapling/Gatekeeper checks, all native suites against that exact signed artifact, supported-Mac acceptance and the full license/source/SBOM audit. This implementation does not substitute its private test for those gates.

## Existing projects and resource packs

Signing creates a new exact compiler identity. Existing projects retain their old recorded identity and managed compiler copy. They move only through the existing backed-up [compiler comparison and Apply flow](COMPILER_MIGRATION.md).

The current public table pack targets the original unsigned base. A distribution release must build and authenticate a pack/catalog entry for the **actual final signed base**, then pass download, installation, preview, Apply and restart acceptance. Do not relabel the old pack or accept it against a different base. Secure timestamp differences may produce different runtime identities between signed builds, so prepare packs from the final artifact, not an assumed future rebuild.

Exact local evidence is recorded in [runtime signing verification](releases/runtime-signing-verification.json). The preceding unsigned history release is separately qualified in [the hosted history record](releases/mac-history-storage-verification.json).
