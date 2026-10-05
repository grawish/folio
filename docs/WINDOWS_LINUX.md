# Windows and Linux previews

Folio ships unsigned x64 preview builds for Windows and Linux alongside the Apple silicon DMG. They contain the same app, templates and locked LaTeX resource bundle (`folio-core-v1`), with the official upstream Tectonic 0.17.0 and Biber 2.17 binaries for each platform.

## Downloads

| Platform                | Files                                                              | Notes                                                                                                                                                                                |
| ----------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Windows 10/11 x64       | `Folio-<version>-win-x64-setup.exe`, `Folio-<version>-win-x64.zip` | Per-user installer; you can choose the folder. SmartScreen warns because the build is unsigned: **More info → Run anyway**.                                                          |
| Linux x64 (glibc 2.35+) | `.deb`, `.AppImage`, `.tar.gz`                                     | Prefer the `.deb` (`sudo apt install ./Folio-*.deb`). The AppImage needs `libfuse2`; on Ubuntu 24.04+ it may need `--no-sandbox` because of the AppArmor user-namespace restriction. |

Every release includes `SHA256SUMS-win.txt` and `SHA256SUMS-linux.txt`.

## What differs from macOS

| Area                              | macOS                                     | Linux                                                                                                                           | Windows                                                                                    |
| --------------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Compiler isolation                | `sandbox-exec` profile (`macos-seatbelt`) | Kernel limits via `ulimit` (CPU, 128 MiB file size, 256 open files, no core dumps) and Tectonic untrusted mode (`posix-limits`) | Tectonic untrusted mode with the wall-clock timer and process-tree kill (`untrusted-mode`) |
| Compiler stops if Folio is killed | Yes (parent-watch descriptor)             | Yes (parent-watch descriptor)                                                                                                   | No; an orphaned build ends at completion                                                   |
| Biber Perl archive                | Pre-expanded inside the read-only runtime | Expanded once per compiler into `…/biber-par/<pin>` in Folio's data folder                                                      | Same as Linux                                                                              |
| Signed app updates                | Planned (requires Developer ID)           | Not available; download new releases from GitHub                                                                                | Not available; download new releases from GitHub                                           |
| Resource packs                    | Available                                 | Not yet (packs are built for the Apple silicon compiler)                                                                        | Not yet                                                                                    |

Tectonic's untrusted mode disables shell escape and other features that let a document run programs. Projects are portable: a project saved on a Mac opens on Windows/Linux and uses the matching local compiler when the Tectonic version, resource bundle and Biber version are the same.

## Building

```bash
npm ci
npm run setup            # pinned Tectonic + Biber, locked bundle, offline template checks
npm run dist:linux       # on Linux x64
npm run dist:win         # on Windows x64
node --import tsx scripts/test-compile-native.ts   # production compiler smoke test
```

Biber's Windows and Linux archives come from SourceForge and must be pinned once with `node scripts/pin-biber.mjs` (or the **Pin Biber archives** workflow) before `npm run setup` accepts them.

The **Release Windows and Linux previews** workflow (`.github/workflows/release-desktop.yml`) builds both platforms, runs the cross-platform tests and native compile smoke test, and attaches the installers to a GitHub pre-release whose tag must equal `v<package.json version>`.

## Known gaps

- Builds are not code-signed (Authenticode) and the Linux packages are not GPG-signed.
- The Electron, Tectonic and Biber notice bundles are the complete upstream originals shared with the Mac build; a per-platform binary inventory and SBOM like the Mac qualification has not been produced yet.
- The native Mac UI suites (`scripts/test-*.mjs`) have not been ported; Windows/Linux coverage is the cross-platform unit tests plus the compile smoke test.
