# Managed resource packs: catalog and transfer protocol

The authenticated catalog and resumable download core is implemented and tested. **Resource-pack installation is not yet available in the desktop app.** These modules are not connected to IPC or Settings, and no production signing key, public pack catalog or pack archive is configured. The remaining work below is part of the original release goal, not an optional replacement for it.

The purpose is to let a user add supported LaTeX resources, or restore an exact missing pack, without allowing the compiler to fetch arbitrary packages. A download by itself must never change a project's recorded compiler or source. The existing backed-up compiler comparison remains the model for a later explicit project change.

## Authentication

`electron/core/pack-catalog.ts` accepts an envelope with exactly `keyId`, `payload` and `signature`. Payload and signature are canonical base64 strings. The publisher signs the UTF-8 bytes `Folio resource pack catalog v1\n` followed by the exact decoded payload bytes using Ed25519. The newline is an actual newline byte. The signature is 64 bytes. A verifier receives its public keys and HTTPS host list from trusted native configuration; it never accepts a key supplied by the catalog itself. [Node 24's signing and verification API](https://nodejs.org/docs/latest-v24.x/api/crypto.html#cryptoverifyalgorithm-data-key-signature-callback) supplies the cryptographic primitive.

The decoded payload has exactly these fields:

| Field | Required meaning |
| --- | --- |
| `schemaVersion` | Integer 1 |
| `sequence` | Positive safe integer, at least the app's configured version floor |
| `issuedAt`, `expiresAt` | UTC ISO timestamps with milliseconds; a positive validity period of at most 90 days and at most five minutes of future clock skew |
| `packs` | At most 128 distinct pack entries |

Each pack has a stable `id`, plain-text `title` and `description`, exact `base` and `target` Apple silicon runtime pins, the resource filenames in `packages`, and `artifact` with an HTTPS `url`, lowercase SHA-256 and exact byte count. Base and target must retain the same Tectonic/Biber version labels and have different identities. The future installer must additionally prove that executable bytes remain identical to the base; metadata labels alone do not prove that.

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

No code in this phase extracts a pack archive, executes downloaded files, changes the active runtime or changes a project. The eventual installer must revalidate downloaded bytes and the signed resource inventory before use; a returned cache path is not a permanent integrity guarantee against later local edits. Full cache/history retention policy, filesystem power-loss acceptance and application-wide memory/disk quotas remain separate requirements.

## Verification

Run:

```sh
node --import tsx --test tests/pack-download.test.ts
npm run typecheck
npm test
```

Fifteen protocol tests cover pinned-key/context authentication, malformed and expired catalogs, version floors, restart and rollback rejection, immutable capabilities, complete-cache reuse, cancellation, resumed and full responses, wrong ranges/validators/encoding, damaged prefixes, excess bytes, invalid hashes, rejected redirects, linked storage, overlapping operations, truncated streams, a real stalled HTTP body timeout, and a simulated short write followed by disk-full failure.

An actual child process is killed at received-byte, verified-before-publication and published boundaries. A new downloader resumes or reuses the exact signed bytes in all three cases. The fixture uses a referenced interval while awaiting its kill, avoiding the earlier Node top-level-await liveness issue. Network tests use a local HTTP server through an explicit test-only transport mapping; they test the range/timeout protocol, not public-server TLS acceptance. All keys and payloads are synthetic. No provider account or production publisher key is used.

Local evidence: `test-results/pack-core-tests.log`, `pack-core-typecheck.log` and the complete unit-suite log recorded in the release audit. The existing 13-suite hosted Mac qualification covers the earlier guided-recovery app at 274ff95; it does not establish completed pack functionality.

## Required next work

1. Define and implement the signed offline pack archive, bounded resource parsing, notices/inventory verification, deterministic assembly against the exact base runtime, and a publisher build/signing command. Imported packs must authenticate without trusting a checksum sidecar alone.
2. Stage and self-test an assembled runtime, preserve active and leased copies, and publish only after durable verification. Prove failed/aborted/interrupted installation retains the old compiler. Integrate exact-pack repair without silently changing project pins.
3. Add Settings-only catalog refresh, local import, download progress/cancel/resume, cache removal, installed-pack status and explicit backed-up compiler comparison. Pause conflicting operations and handle native close and renderer reload.
4. Configure production public trust roots, catalog hosting, sequence/expiry publishing and key rotation/revocation. Complete the selected packs' redistribution materials before publishing their bytes. Keep private signing keys out of the repository, app and public artifacts.
5. Run actual offline resource compilation and native source/package acceptance, capture real UI demos in both themes, update the tutorials and generated skill, and qualify the final artifact. Do not present the protocol tests as those missing user workflows.
