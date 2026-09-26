# Managed resource packs: authenticated transfer and installation

The native core supports signed catalogs, resumable downloads, authenticated offline archives, deterministic bundle assembly, staged installation and exact repair from retained signed archives. **Settings → LaTeX resources is now connected to the native pack service.** The ordinary build now includes the public Folio publisher key and HTTPS catalog. [The first table pack](https://github.com/grawish/folio/releases/tag/resource-packs-v1) adds Multirow 2.9, bigstrut and bigdelim with unchanged supporting resources and separate upstream notices. Public downloads and hosted catalog renewal are verified; final packaged acceptance remains separate. The remaining work below is part of the original release goal.

The purpose is to let a user add supported LaTeX resources, or restore an exact missing pack, without allowing the compiler to fetch arbitrary packages. A download by itself must never change a project's recorded compiler or source. The backed-up compiler comparison handles the later explicit project change.

## Authentication

`electron/core/pack-catalog.ts` accepts an envelope with exactly `keyId`, `payload` and `signature`. Payload and signature are canonical base64 strings. The publisher signs the UTF-8 bytes `Folio resource pack catalog v1\n` followed by the exact decoded payload bytes using Ed25519. The newline is an actual newline byte. The signature is 64 bytes. A verifier receives its public keys and HTTPS host list from trusted native configuration; it never accepts a key supplied by the catalog itself. [Node 24's signing and verification API](https://nodejs.org/docs/latest-v24.x/api/crypto.html#cryptoverifyalgorithm-data-key-signature-callback) supplies the cryptographic primitive.

The decoded payload has exactly these fields:

| Field | Required meaning |
| --- | --- |
| `schemaVersion` | Integer 1 |
| `sequence` | Positive safe integer, at least the app's configured version floor |
| `issuedAt`, `expiresAt` | UTC ISO timestamps with milliseconds; a positive validity period of at most 90 days and at most five minutes of future clock skew |
| `packs` | At most 128 distinct pack entries |

Each pack has a stable `id`, plain-text `title` and `description`, exact `base` and `target` Apple silicon runtime pins, the resource filenames in `packages`, and `artifact` with an HTTPS `url`, lowercase SHA-256 and exact byte count. Base and target must retain the same Tectonic/Biber version labels and have different identities. Assembly additionally preserves every base native-file hash; metadata labels alone do not prove that.

The envelope is bounded at 2 MiB, decoded payload at 1 MiB, and each download at 128 MiB. Duplicate IDs, duplicate target identities, case-colliding resource names, unknown fields, invalid pins, unsupported key types and unapproved download hosts are rejected. Pack entries and their nested values are frozen and registered as native capabilities after authentication; an object copied through JSON cannot authorize a download.

`PackCatalogStore` keeps the signed envelope in `catalog.json`, using a flushed temporary file, atomic rename and directory flush. It rejects a lower sequence and rejects different payload bytes under the same sequence. Expired or below-current-floor cached metadata can still establish the previous sequence when accepting a newer catalog; it cannot authorize a new transfer. Invalid cached metadata fails closed instead of silently resetting the rollback floor. Catalog expiry also gets checked when an earlier verified download capability is used.

Historical authenticated entries may authorize deletion of their owned cached downloads. This lets cleanup work after metadata expires without allowing an expired entry to start a new transfer. Deleting the whole application profile is outside the saved sequence's protection. Publisher key rotation/revocation and production trust configuration still need the release design and acceptance listed below.

## Resuming a transfer

`electron/core/pack-download.ts` stores each transfer under its signed content hash. `resume.json` records the expected hash/size/original URL and an optional strong ETag; `payload.part` contains received bytes. Neither file grants authenticity by itself.

1. Validate the authenticated, unexpired pack and its HTTPS host. Recheck every redirect; allow at most five redirects and no credentials, fragments, alternate ports or automatic cross-host trust.
2. Reuse a completed `payload.foliopack` only after reading it and checking its full signed size and hash again.
3. Resume a partial file with an exact byte range and its strong `If-Range` ETag, when available. Only accept a 206 response with the expected complete remaining range, total size and matching validator. A 200 response restarts the partial file from zero. This follows the distinction between complete and partial responses in [HTTP range semantics](https://www.rfc-editor.org/rfc/rfc9110.html#section-14) and [If-Range](https://www.rfc-editor.org/rfc/rfc9110.html#section-13.1.5).
4. Stream bounded bytes through positional writes, handling short filesystem writes. Reject response compression, wrong declared lengths and excess bytes. A transfer attempt has a 90-second default deadline covering both headers and body; cancellation uses the same abort path.
5. On cancellation, timeout, network truncation or a disk-write failure, flush and retain the actual received prefix. The next attempt derives its offset from the real file size. Invalid range/encoding/hash results reset that owned partial file so a retry can start cleanly.
6. Re-read the complete file, including the retained prefix, and verify its signed SHA-256 before syncing and atomically publishing the completed filename. A process killed after full receipt but before publication can verify and publish the complete prefix without downloading it again.

`pack-io.ts` checks canonical directory ancestry before creating storage and rejects linked directories, symbolic/hard-linked files and oversized or special files. Cleanup deletes only the three known cache filenames, never an arbitrary recursive tree. Overlapping downloads and cleanup are rejected across downloader instances in one process. Desktop integration must retain the existing per-profile single-instance lock and use one catalog store per profile; this core is not a general multi-process database.

Downloading alone never changes the active runtime or a project. The archive verifier rechecks downloaded bytes and the signed resource inventory before installation; a returned cache path is not a permanent integrity guarantee against later local edits. Full cache/history retention policy, filesystem power-loss acceptance and application-wide memory/disk quotas remain separate requirements.

## Offline archive and assembly

`resource-pack.ts` accepts a bounded ZIP containing `metadata.json`, `NOTICES.txt`, `probe.tex` and `resources/<filename>`. The signed envelope uses the same configured Ed25519 keys and envelope bounds, but a separate context: `Folio resource pack archive v1\n`. A catalog signature cannot substitute for an archive signature. The decoded descriptor has exactly `schemaVersion` (1), `id`, `title`, `description`, `base`, `target`, `packages`, `files`, `notices` and `probe`. Each `files` entry, and the notices/probe entries, records an exact `bytes` count and `sha256`.

The archive permits at most 512 resources, each no larger than 20 MiB, with 4 MiB notices and a 256 KiB UTF-8 test document. Compressed and expanded archive sizes are each bounded at 128 MiB. File names must be flat supported TeX/font/image resource names; native binaries, arbitrary paths, case collisions, links, damaged ZIP records, missing and extra non-directory entries are rejected. The parser checks expansion bounds before decompressing. Its signed metadata is frozen; resource buffers stay private and are copied when returned. A plain JSON clone cannot authorize installation.

Offline archives do not expire independently. They must still verify against the caller's currently configured trust roots on every import or repair. Online download/catalog use also requires unexpired catalog metadata and matching archive size, hash, labels, resource names and runtime pins. Production key revocation and rotation remain required; no archive-supplied key is trusted.

Assembly verifies the exact base runtime, reads its flat bundle, applies the signed resources and creates a new sorted inventory and `SHA256SUM`. ZIP entries use a fixed local calendar date so the bytes are identical across time zones; using a fixed UTC instant would give different ZIP calendar fields on different machines. The final bundle remains bounded at 128 MiB compressed and 256 MiB expanded. The new runtime manifest preserves all native base hashes and adds hashes for the assembled bundle, resource lock, combined notices and `pack-check.tex`. Its computed pin must exactly match the signed target. Changed base bytes or even changed inherited notices cannot silently produce a different target.

## Staging and repair

`RuntimeManager.installPack` builds a separate generation, copies the existing native files and writes the resource overrides. It verifies every staged file before running the normal offline TeX/Biber check and the pack's signed test document through the production compiler sandbox. Each check has a 60-second bound. Only a successful stage receives `ready.json` and an atomic active pointer for that target identity. Installation never changes the app's default compiler or a project's recorded choice; Settings uses explicit, backed-up compiler comparison to change a project.

Cancellation is checked before preparation, between asynchronous stages/copies and immediately before pointer publication. During compilation it cancels the compiler and waits for shutdown. Synchronous bounded ZIP work is not instantly interruptible. Publication is a commit boundary: an error or cancellation arriving after it begins must not be described as a rollback. Cleanup preserves the active copy, one previous copy and every leased copy. Failed pre-publication work is removed; unfinished process-killed generations are ignored and cleaned on a successful retry.

`ResourcePackStore` retains the signed archive under its exact target ID. Repair first uses an existing verified copy, or reauthenticates that retained archive and rebuilds the same target using a verified local base. A matching included base is also usable. Missing non-default base dependencies must be installed/repaired first; this core does not recursively fetch a chain of dependencies. Invalid retained bytes cannot grant repair. Runtime and archive storage reject linked ancestors. One native manager/store per profile and the app's existing profile lock remain necessary.

## Publisher command

This is a maintainer tool, not an end-user pack-import workflow. Prepare a directory containing `recipe.json`, `NOTICES.txt`, `probe.tex` and a flat `resources/` folder. The recipe contains exactly:

```json
{
  "id": "folio-example-v1",
  "title": "Example resources",
  "description": "Describe the resources and their purpose.",
  "bundle": "folio-example-v1",
  "packages": ["folio-example.sty"],
  "keyId": "publisher-key-id"
}
```

Use an existing private Ed25519 PEM key stored outside the repository and an exact verified Apple silicon base runtime:

```sh
node --import tsx scripts/build-resource-pack.ts \
  /path/to/pack/recipe.json /path/to/base-runtime \
  /private/path/publisher-key.pem /path/to/output.foliopack
```

The command bounds inputs, rejects unsupported files and linked resources, builds and signs the archive, then verifies its signature and inventory with the corresponding public key. It refuses to overwrite an existing output and prints only public metadata, target identity, archive size and digest. It does not run the compatibility probe, upload files, publish a catalog or configure application trust. Install/test the artifact with the production runtime core and review all resource licenses/notices before publication. No production private key or distributable pack is committed by these tests.

## Verification

Run:

```sh
node --import tsx --test tests/pack-download.test.ts
node --import tsx --test tests/resource-pack.test.ts
node --import tsx --test tests/integration/resource-pack.test.ts
npm run typecheck
npm test
```

Fifteen protocol tests cover pinned-key/context authentication, malformed and expired catalogs, version floors, restart and rollback rejection, immutable capabilities, complete-cache reuse, cancellation, resumed and full responses, wrong ranges/validators/encoding, damaged prefixes, excess bytes, invalid hashes, rejected redirects, linked storage, overlapping operations, truncated streams, a real stalled HTTP body timeout, and a simulated short write followed by disk-full failure.

An actual child process is killed at received-byte, verified-before-publication and published boundaries. A new downloader resumes or reuses the exact signed bytes in all three cases. The fixture uses a referenced interval while awaiting its kill, avoiding the earlier Node top-level-await liveness issue. Network tests use a local HTTP server through an explicit test-only transport mapping; they test the range/timeout protocol, not public-server TLS acceptance. All keys and payloads are synthetic. No provider account or production publisher key is used.

Eleven archive/installation tests additionally cover byte-identical publisher output in UTC, India and Los Angeles time zones; immutable authenticated inputs; archive tampering and catalog mismatch; changed base files/notices; signed target mismatch; executable preservation; leased copies; retained-archive repair; cancellation; linked ancestors; and failures before and after publication. A separate child is actually killed at staged, tested and published installation boundaries, then restarted and retried. Synthetic engine fixtures never execute.

The real compiler integration uses an original tiny `.sty` fixture with temporary signing keys. It proves the base cannot use the missing package, the signed target can compile it offline, the project's base choice remains unchanged, the base still compiles ordinary documents, and a validly signed pack with a broken probe is refused without damaging working compilers. It also runs the real base/Biber preparation checks. This does not establish native Settings acceptance or redistribution readiness of third-party packs.

Local evidence is recorded in `test-results/resource-pack-tests.log`, `resource-pack-runtime-final.log`, `resource-pack-integration.log`, `resource-pack-all-integration.log` (all 15 compiler integrations pass), `resource-pack-all-unit.log` (all 184 unit/protocol tests pass), `resource-pack-typecheck.log`, `resource-pack-build.log` and `resource-pack-format.log`. The source-native existing repair/startup workflow also passes with zero renderer errors (`test-results/resource-pack-native-runtime.log`, `test-results/runtime-dwz1v4/result.json`). It verifies preservation of edits, exact pins, ZIP/history and restart behavior; it is not a pack Settings test. The existing 13-suite hosted Mac qualification covers the earlier guided-recovery app at 274ff95; it does not establish completed pack functionality.

## Settings integration and current evidence

`PackService` owns one catalog store, downloader, retained-archive store and operation lock per profile. Catalog refresh uses a 30-second bounded HTTPS request with redirect host checks and a 2 MiB response limit. Local file selection uses the native dialog, bounded regular-file reads and signed inventory verification. Import review holds an immutable native copy until installation or cancellation. Renderer metadata cannot authorize a runtime: comparison resolves the target ID again from the authenticated native index and checks the installed bytes.

The Settings screen provides catalog refresh, import/review/discard, byte/file progress, cancellation, resume, local retry, cache clearing and an explicit preview action. It is separate from AI connections. Project operations pause during pack work; renderer reload and native close cancel and await it before recovery proceeds. Signed archives are retained before staging so interrupted preparation can be retried offline. Clearing a download keeps installed compilers and retained archives. Library refresh validates retained archives again and reports damaged ones instead of silently using them.

An explicitly chosen installed pack may fix a missing dependency that prevents a before PDF. The comparison then shows an honest unavailable-before state, keeps `before-error.txt` instead of a fake PDF, and still requires a successful new PDF, complete source/history backup and explicit Apply. Ordinary included-compiler comparisons retain their previous failure rules. Apply checks the target runtime again before committing the new project pin.

The current source passes 198 unit/protocol tests (`test-results/pack-publisher-all-unit.log`), including six native-service tests and two new comparison tests. The service tests cover immutable reviewed bytes, authoritative target selection, signed catalog rollback/expiry/redirect rejection, coordinated download/installation, cancellation and offline retry, corrupt retained archives and an interrupted native picker. The source-native workflow is `npm run test:packs`. Its final passing evidence is in `test-results/pack-settings-native-cancel.log` and `test-results/packs-yDXAXa/result.json`, with zero renderer errors. This includes cancellation while the renderer is still preserving the draft, before any catalog request can begin. Earlier development screenshots came from `test-results/packs-6h4KFI/`. The current gallery now uses the public-catalog run described below; current hashes and publisher scope are recorded in `docs/images/qualified-captures.json`. It covers reviewed import/discard, cancel/resume, native close, renderer reload during staging, offline retry, explicit preview/Apply, backup contents and save/restart. The ordinary included-compiler comparison regression also passes with zero renderer errors (`test-results/pack-settings-migration-regression.log`, `test-results/migration-INw5ck/result.json`).

The native test builds with a temporary public trust key through the build function's explicit test option. Ordinary build/pack/dist do not pass that option; no runtime environment variable or renderer request can change the trusted keys. Its transport is simulated HTTPS, while resource assembly, disk copying, Tectonic/Biber checks, compilation, PDF viewing, backup, recovery and save are real. A `finally` block restores the ordinary native build. These checks do not verify public-host TLS, production key custody/rotation, third-party pack redistribution, or a final signed/notarized artifact. See [the user walkthrough](tutorials/resource-packs.md).

## Public publisher and key retirement

The public publisher key, reproducible source lock, release inventory and bounded renewal command are described in [PACK_PUBLISHING.md](PACK_PUBLISHING.md). Private signing material stays outside the repository and in the private renewal secret. The published table pack includes complete pinned upstream source/material archives and separate notices. The real native core passed all six offline table cases (A4/US Letter at 10/11/12 points), preserved the included compiler and produced readable inspected PDFs. The real HTTPS transfer check stopped at 32,768 bytes, resumed with HTTP 206 and verified the full hash and publisher signature. Hosted renewal run `36239242245` verified every public asset and published catalog sequence 2. The [verification record](releases/resource-pack-verification.json) preserves hashes, source commit, corpus and network evidence. These checks do not qualify a final packaged Mac installer.

A retired key can authenticate historical metadata only to retain the saved catalog sequence and identify cache files. It cannot authorize a new catalog, download, import or archive repair. Tests cover replacement-key renewal without resetting the rollback floor. Retirement reaches users with an app trust update; an old offline app cannot discover it automatically.

## Normal-app public catalog acceptance

`npm run test:pack-catalog` passes against the ordinary source application with the compiled public key and real HTTPS catalog/archive. It verifies fresh-profile download, exact archive digest, native installation and offline compiler checks, unchanged project pin before Apply, complete import notices, a real table PDF, backup, save and restart. The compact light and dark screenshots are inspected. Evidence is `test-results/public-pack-native-final.log` and `test-results/pack-catalog-meOC9s/result.json`, with zero renderer errors; the portable result is included in `releases/resource-pack-verification.json`. The first run stopped at an incorrectly capitalized license-title assertion in the test; that assertion was corrected and the full run repeated from a fresh profile. No app behavior was changed to make it pass.

The three current tutorial/gallery captures now come from this real public-publisher run. Their synthetic content is the table document, not the publisher or network. The earlier simulated interruption suite remains useful for deterministic failure coverage. The public workflow accepts an app executable argument and is included in the fourteen-suite Mac qualification, whose final artifact evidence remains a separate requirement.

## Required next work

1. Run the fourteen-suite Mac qualification, including the public catalog workflow, against the exact final packaged artifact. Earlier thirteen-suite artifacts predate resource packs.
2. Keep large-pack responsiveness, disk/memory quotas, historical cache retention, key-rotation incident drills and power-loss testing in scope. Private signing keys must stay out of source/app/public artifacts.
