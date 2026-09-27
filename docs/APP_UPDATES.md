# Application updates

The current source adds **Settings → App updates**, separate Stable and Beta channels, opt-in checks, authenticated release metadata, a pinned `electron-updater` 6.8.10 Mac adapter and a recovery-before-restart path. This is not an active production update service yet. `resources/app-update-publisher.json` deliberately has no trusted app-update key or Apple Team ID. The public unsigned preview cannot update itself. A real signed-to-signed install remains required before enabling publication.

## User behavior

Checks start off. Enabling **Check automatically** checks 20 seconds after launch and every six hours while idle. An available or downloaded update is retained until the user acts. Checking never downloads or restarts. **Download update** fetches a full ZIP. **Save recovery & restart** is a separate action. A normal quit never requests native update staging.

Stable accepts regular release versions. Beta accepts regular releases and `X.Y.Z-beta.N`. Neither channel installs a lower or equal version. Moving from Beta to Stable may therefore wait for a newer stable release. No downgrade is offered: compatibility of local data is not assumed. Each manifest advertises the data epochs it can read; the current source writes epoch 1. Increment `APP_DATA_EPOCH` when a change makes local data unreadable by older versions.

Settings retains preferences and an installation attempt record. The next launch compares its actual version with that record and reports whether the target started. A failed update leaves the recovery data available. **Downloads on GitHub** provides the manual reinstall fallback. User-created project folders are not deleted by this feature.

## Authentication and transport

`electron/core/update-manifest.ts` verifies an Ed25519 envelope with the domain separator `Folio application update v1\n`. App-update keys are separate from resource-pack keys. The signed payload binds:

- Schema, application ID `app.folio.resume`, platform `darwin-arm64` and channel.
- Monotonic sequence, issue time and expiry, with at most 45 days of validity.
- Exact version, plain-text release notes, minimum Darwin kernel version, accepted data epochs and rollout percentage.
- The exact official GitHub release ZIP URL, its byte length and SHA-512 checksum, and the matching release page.

A `release: null` payload withdraws an offered release without authorizing a replacement. Each channel's highest accepted sequence and payload digest are saved before an update is offered. Older sequences and different payloads at the same sequence are rejected across launches. Unknown/retired keys, malformed versions, unsafe URLs, expired metadata and damaged local trust state fail closed. A SHA-512 checksum alone is not treated as authentication. Download clicks fetch and authenticate the channel again; a changed or withdrawn offer is rejected before the ZIP transfer.

Metadata fetches omit credentials, have a 30-second deadline and a 128 KiB envelope limit enforced on received bytes. Every redirect must remain HTTPS on the approved GitHub hosts. A local random cohort selects rollout eligibility; it is never transmitted. Starting with 10% and later increasing the signed percentage keeps the initial group stable. Replacing or renewing metadata requires a higher sequence.

`update-provider.ts` supplies the exact authenticated object to the matching updater's custom provider interface. There is no second unsigned YAML fetch after verification. The Mac adapter disables differential downloads until signed blockmaps are supported. The custom provider installs a bounded transfer hook on the pinned updater's supplied HTTP executor. It uses that updater's Electron session, checks each chunk against the signed size before writing, validates SHA-512, and closes the request and file before returning. Folio also checks the complete cached ZIP's size, hash and file identity after download and again before native staging. This avoids relying on the updater's same-process existence-only cache fast path. The updater's network session rejects unapproved redirect hosts and protocols. The transfer hook independently checks every redirect, omits credentials, rejects changed encodings and inconsistent length headers, and still bounds bodies that omit Content-Length. It handles short filesystem writes and refuses linked output before truncation. Progress reports are limited to roughly ten per second. A 30-second idle timeout and the outer 15-minute deadline cancel the active request; cancellation settles only after the file closes.

## Restart and recovery

The renderer blocks restart during an active save, build, AI request, import, history operation or compiler change. The main process independently rejects competing IPC requests, active AI work and project operations. Once accepted, the main process blocks new work, drains prior recovery/workspace writes, cancels compilation, saves the current project and conversation, flushes them, and writes an installation attempt record. Any failure prevents native installation.

Only then does Squirrel.Mac receive the local ZIP through electron-updater's authenticated loopback server. Its native signature acceptance precedes `quitAndInstall`. Ordinary app shutdown retains the existing save/recovery flow. These implementation paths still need the production two-version test below; service tests with an installer double are not proof of native installation.

Native staging has a two-minute deadline. A timeout, native error or missing-update response rejects the restart request, releases the app's existing restart guards and keeps the saved recovery and attempt record. Settings explains how to keep working and disables further installation until Folio is reopened. Checks and channel preferences remain usable. The native API has no cancellation method or request identifier, so this is a return to editing, not a claim that macOS cancelled staging: it may finish the approved update when Folio next closes. Save subsequent work before quitting.

`update-staging.ts` permits only one native staging attempt per process. Failure removes its ready/error listeners; a late ready event cannot call `quitAndInstall`, and the adapter rejects another download before changing the native feed. This prevents a delayed event for the first ZIP from triggering a restart for a later download. The pinned MacUpdater retains its own listeners, but with automatic installation disabled it does not quit in response to those events. The deadline covers waiting for native readiness, not macOS completing installation after Folio exits. These behaviors were checked against [Electron 44.4.5's native updater](https://github.com/electron/electron/blob/v44.4.5/shell/browser/auto_updater_mac.mm) and the installed MacUpdater 6.8.10 source.

## Publishing a production update

1. Enroll a separate Ed25519 public key and the actual expected Developer ID Team ID in `resources/app-update-publisher.json`. Keep the private key outside Git, readable only by its owner. Retain retired public keys with their IDs in `retiredKeys`; never reuse an ID for another key. Ship the trust configuration in the signed base release.
2. Build and qualify the exact signed app, DMG and ZIP using [Mac signing](MAC_SIGNING.md). Run `npm run release:finalize-dmg -- RELEASE_DIR` and complete production verification before generating checksums or update metadata. If Apple is still processing, resume that same submission before proceeding. Record a unique version/tag; do not replace an existing version's ZIP.
3. Write a release plan such as this example. Dates are illustrative and must be replaced with a current expiry no more than 45 days after issue. `minimumSystemVersion` is a Darwin kernel version, not the macOS marketing version.

```json
{
  "channel": "beta",
  "sequence": 1,
  "expiresAt": "2026-10-20T00:00:00.000Z",
  "version": "0.2.0-beta.1",
  "notes": "Describe the actual changes and known limits.",
  "minimumSystemVersion": "24.0.0",
  "rollout": 10,
  "dataEpoch": { "minimum": 1, "maximum": 1 }
}
```

4. Run the publisher with a **new** output path:

```sh
node --import tsx scripts/sign-app-update.ts release/production release-plan.json /private/path/app-update-key.pem /private/path/beta.json
```

The command re-runs `verify-mac-package.mjs --distribution`, checks the packaged version, checks the final ZIP against the actual archive evidence, computes SHA-512, signs and verifies the complete envelope, and refuses to overwrite an existing output. Missing keys, ad-hoc signing or a stale positive verification report cannot publish an app update through this command. A withdrawal plan uses `version: null`, a higher sequence and a new expiry; no artifact is authorized by it.

5. Publish the exact checked ZIP, DMG and release materials under the matching GitHub tag. Re-download and validate the ZIP from its final URL. Only then commit the signed channel file to `resources/updates/stable.json` or `beta.json`. Increase the rollout with another signed sequence after checking actual update results. Renew before expiry; there is no automatic app-feed renewal workflow yet.

## Evidence and remaining acceptance

`tests/app-updates.test.ts` covers signatures, contexts, key retirement, bounded metadata, URL policy, independent channel floors, withdrawals, replay/equivocation, rollout cohorts, version/data compatibility, the actual custom-provider class, cancellation and save/journal failures. Installer doubles test orchestration only.

`npm run test:updates` launches the real Electron app with an isolated profile. It checks Settings, persisted preferences, unsigned-preview gating, light/dark/compact controls, the native menu, and ordinary close/relaunch recovery with synthetic text. It does not install an app update. Curated screenshots and the [user tutorial](tutorials/app-updates.md) distinguish that scope.

The same test injects one controlled restart IPC rejection into the real renderer. It verifies that Settings unlocks, installation controls disappear and new project/chat edits survive normal close/reopen. This injection does not exercise native staging or prove main-process recovery from a real macOS timeout. Timer-controlled unit tests cover the exact deadline, late and duplicate events, no-update responses, concurrent attempts, synchronous quit failures and listener cleanup. Service tests check durable recovery/attempt ordering and the restart-required state across channel changes and a new service instance.

### Actual Electron transfer controls

`npm run test:update-download` bundles the actual updater adapter into a standalone Electron test process. An ephemeral signing key authorizes an inert ZIP containing text and random bytes. An Electron HTTPS protocol handler supplies deterministic responses; there is no public download or runnable app. Only this unpackaged fixture's development-check flag and cache location are changed, so it cannot touch the user's update cache. The real custom provider, bounded Electron session transfer, MacUpdater cache/publish path and authenticated loopback ZIP server are exercised.

The controls cover a successful transfer and full ZIP hash, rejected unauthenticated loopback requests, valid offline cache reuse, same-size cache damage and successful retry, network checksum rejection, blocked redirects, interrupted transfer/retry and an oversized chunked response. Additional filesystem controls prove that excess chunks never reach disk, cancellation closes the stream and leaves no later writes, and linked output cannot overwrite its target. These tests do not request Squirrel.Mac installation. See [transfer verification](releases/update-download-verification.json).

After the transfer controls, the fixture intercepts the native check entry point with a controlled failure. The real adapter and native event emitter then prove that a late ready/error event cannot request quit, and another install or download cannot change the feed or begin a transfer. No inert ZIP is handed to Squirrel. See [staging recovery verification](releases/update-staging-verification.json) for exact inputs and the distinction between these controls and actual signed replacement.

The fixture is a separate Mac qualification step. Its result, input hashes, progress and failure logs are retained with CI evidence. Unexpected asynchronous errors fail the fixture, and a 90-second hard process deadline prevents an Electron error dialog from leaving CI stuck. Changing the pinned updater requires rerunning it: the transfer hook relies on the custom provider's supplied executor being the one used for its download.

The transfer uses Electron's `net.request` and its Node readable response directly. The actual Electron controls reproduced an intermittent uncaught `ERR_INVALID_STATE` error with the `session.fetch` Web-stream bridge during abort. The direct stream avoids that bridge, keeps backpressure during file writes, and aborts the request when its response closes. In pinned Electron 44, the request's Writable `close` event can occur before the response, so cancellation stays attached until the response closes. This behavior was checked against [Electron's pinned request implementation](https://github.com/electron/electron/blob/v44.4.5/lib/common/api/net-client-request.ts).

Still required before enabling production updates:

- Two independently built, Developer ID signed and notarized versions, installed from real downloads, with a real Squirrel.Mac upgrade and exact resulting version/app identity.
- Public-network interrupted download/retry and a real signed ZIP, native signature rejection, interrupted staging and restart recovery, including source/assets/chat/PDF notes and unsaved composer text. Deterministic Electron transfer/corrupt-cache controls now pass, with a deliberately inert ZIP.
- Final publisher enrollment, live stable/beta signed feeds, scheduled renewal and publication automation bound to the qualified artifacts. Publisher commands currently prepare files; they do not upload them.
- Disk-space/download-cache policy, real signed staging timeout/recovery acceptance, and supported-Mac upgrade/reinstall/uninstall acceptance. The timeout and recovery UI are implemented with controlled event and renderer tests; actual signed macOS behavior remains unverified.

Pinned upstream behavior was checked against the installed 6.8.10 source and the [electron-builder v26 update guide](https://www.electron.build/v26/docs/features/auto-update/). macOS needs the ZIP target and code signing. See also [Electron's native updater API](https://www.electronjs.org/docs/latest/api/auto-updater).
