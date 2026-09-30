import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readRemovedFileArchive } from '../electron/core/project';

// readRemovedFileArchive (electron/core/project.ts) is the last gate before a
// project's "resume.trash" bytes - read from disk during open() and from
// imported ZIPs during project-import - are parsed as JSON. Its 10 MB + 128
// byte ceiling is distinct from validateRemovedFiles' 10 MB serialized-result
// check in src/shared/project-files.ts: this one bounds the raw input buffer
// before any parsing happens, so an attacker-controlled or corrupted archive
// cannot reach JSON.parse/TextDecoder at all once oversized. No existing test
// exercises this exact accept/reject edge, only validateRemovedFiles' separate
// limit on the already-parsed array (tests/file-management.test.ts).
function archiveOfSize(totalBytes: number): Buffer {
  // { "schemaVersion": 1, "files": [], "padding": "xxx...xxx" } padded to an
  // exact byte length so the boundary is precise rather than approximate.
  const overhead = Buffer.byteLength(JSON.stringify({ schemaVersion: 1, files: [], padding: 'x' }));
  const padLength = totalBytes - (overhead - 1);
  assert.ok(padLength >= 0, 'requested size is smaller than the fixed JSON overhead');
  const bytes = Buffer.from(
    JSON.stringify({ schemaVersion: 1, files: [], padding: 'x'.repeat(padLength) }),
  );
  assert.equal(bytes.byteLength, totalBytes, 'fixture did not land on the requested byte length');
  return bytes;
}

test('removed-file archive accepts exactly 10 MB + 128 bytes and rejects the next byte', () => {
  const limit = 10 * 1024 * 1024 + 128;
  assert.deepEqual(readRemovedFileArchive(archiveOfSize(limit)), []);
  assert.throws(() => readRemovedFileArchive(archiveOfSize(limit + 1)), /exceeds 10 MB/);
});
