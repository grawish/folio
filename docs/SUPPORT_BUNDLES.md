# Reviewable support bundles

**Settings → Privacy → Review support bundle** prepares a small diagnostic snapshot. The user can read every file, leave out sections, and save the selected files to a ZIP using the native save dialog. Folio does not send it anywhere. The optional AI summary starts unchecked; exporting does not contact or sign into a provider.

The four possible files are:

| File | Included information |
| --- | --- |
| `app.json` | Numeric Folio, Electron, Chromium, Node and macOS kernel versions, architecture, packaged/development flag |
| `compiler.json` | Displayed runtime readiness/isolation, numeric compiler version, included-compiler match, last build status and source-match flag, duration, error/warning counts, recognized problem category |
| `workspace.json` | Source file/byte counts, message/note/version counts, saved/unsaved and outside-change flags, appearance and autosave/auto-compile preferences |
| `ai.json` | Configured connection count, active provider type, API format and stored image-check state |

Each selected file includes a format identifier and collection time. These are snapshots of the current window's observed state, not a new compiler integrity check or build. The app version information comes from the native process. An older build is labeled through `buildMatchesSource`; an unfamiliar failure uses the `unknown` category. A recorded image-check state does not establish current provider access.

## Privacy boundary

`src/shared/support.ts` constructs a fixed list of booleans, bounded numbers and enum values before IPC. It derives only the recognized error **category**, never the diagnostic message/title. Source is used to count UTF-8 bytes; its text is not passed to the support exporter. Compiler/resource labels, project IDs/names, source filenames, paths, raw logs, resume/PDF data, chats, notes, history contents, account names, models, endpoints, keys, provider executable locations, environment variables, usernames and hostnames are excluded.

`electron/core/support-bundle.ts` validates and reconstructs each allowed property again. Arbitrary extra fields are discarded. Unknown text in a numeric/enum/boolean field is rejected; nonnumeric version strings become `null`. Native system data is also reduced to this fixed list. The exporter does not read the credential store, project files, log directories, home directory or environment. This is omission by construction; it does not attempt to prove that a free-form log can be cleaned safely with a regular expression.

Users can leave out any section, including version information. At least one section must remain. The selected provider type, counts and timestamps are still information about the user's setup; they are shown in the preview and can be excluded by section. There is no free-text notes field or arbitrary attachment picker.

## Snapshot and file behavior

The native process retains one immutable preview in memory. A random token identifies it. The renderer receives a copy of the exact JSON text; export accepts only the token and a bounded list of known section IDs. It cannot provide replacement file contents or archive paths. Export uses those stored bytes, with only the selected fixed filenames and no extra attachment or hidden manifest.

Replacing or closing the preview invalidates the old token. Cancelling a save dialog keeps the current preview available. A failed write reports a generic error and permits retry. An in-progress export prevents replacement; close/reload waits for it before releasing the snapshot. Cleanup for an older dialog cannot erase a newer preview. Export uses the existing atomic writer with a private `0600` temporary file and rename; it does not claim power-loss durability or change the project/recovery protocols.

## Verification

`tests/support-bundle.test.ts` puts synthetic resume text, email addresses, paths, usernames, connection metadata and environment/secret strings into inputs. It verifies they are absent before IPC and after native validation, rejects malformed allowed fields, checks exact preview/export byte equality and section omission, tests immutable/stale tokens, cancelled saves, write failure/retry and close/export races. The five focused checks and all 135 unit tests passed in `test-results/support-unit.log` and `test-results/support-all-unit.log`.

`scripts/test-support.mjs` exercises the real app with a real compiler font failure, synthetic private markers, dark/light compact layouts, exact ZIP contents, native cancelled/failed saves, reload and a held atomic rename during close. The source-native run `test-results/support-VxAh4m/` and packaged run `test-results/support-tbQGGk/` passed with no renderer errors. The dark and compact light screenshots were visually inspected; curated capture hashes are in `docs/images/qualified-captures.json`. The packaged app is `release/support-bundle/mac-arm64/Folio.app`; app.asar SHA-256 is `3d00715c6135093cceac0b49377539e1a9ac86372463b565c21e114f69f71fcc`. All 37 packaged build outputs and the runtime manifest matched. The exact local record is `release/support-bundle/feature-verification.json`. This is targeted verification of an unsigned app, not the full twelve-suite release qualification or a DMG release. Wider OS/accessibility acceptance remains part of the release audit.

## Useful limits

The bundle is intentionally small and cannot explain every compiler/provider failure. It contains no raw trace or source sample. If support needs more detail, reproduce the problem with a small synthetic project and review any additional material before sharing it. Folio does not create an issue, send email, upload the ZIP or change the selected AI provider. A support ZIP is different from **Export LaTeX source…**, which includes resume content and conversation/history.
