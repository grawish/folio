import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { prepareBiberNotices, verifyBiberNotices } from '../scripts/biber-notices';

const digest = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');
async function fixture(t: TestContext, copy = false) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'folio-biber-notices-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  if (copy) {
    await fs.cp('resources/biber-notices', path.join(root, 'resources/biber-notices'), {
      recursive: true,
    });
    for (const name of [
      'biber-build-provenance.lock.json',
      'runtime-license-sources.lock.json',
      'biber-cpan-sources.lock.json',
      'biber-native-sources.lock.json',
    ])
      await fs.copyFile(path.join('resources', name), path.join(root, 'resources', name));
  }
  return {
    root,
    output: path.join(root, 'output'),
    sources: path.join(root, 'resources/biber-notices'),
  };
}

test('Biber packaging preserves full original license and embedded-declaration documents', async (t) => {
  const { output } = await fixture(t);
  const result = await prepareBiberNotices(output);
  assert.equal(result.compilerVersion, '2.17');
  assert.equal(
    result.originalCompilerSha256,
    'ec2e851a60a36ff9aa756120c728ffec7a8727e4a1a6094e504b0863f2bb7bd4',
  );
  assert.equal(result.components, 136);
  assert.equal(result.originalNoticeReferences, 441);
  assert.equal(result.uniqueOriginalTexts, 414);
  assert.equal(result.expandedTextBytes, 6453696);
  assert.equal(result.records.length, 416);
  assert.equal(result.completeBinarySbom, false);
  const index = JSON.parse(await fs.readFile(path.join(output, 'SOURCES.json'), 'utf8'));
  const noStandalone = index.components.filter(
    (c: any) => c.kind === 'cpan-source-notice-documents' && c.standaloneNoticeFiles.length === 0,
  );
  assert.equal(noStandalone.length, 44);
  for (const c of noStandalone) {
    for (const anchor of c.source.anchors) {
      const ref = c.notices.find((n: any) => n.originalPath === anchor.source);
      assert.ok(ref, `Preserve the complete source declaration document for ${c.id}`);
      assert.equal(digest(await fs.readFile(path.join(output, ref.file))), ref.sha256);
    }
  }
  const lock = JSON.parse(await fs.readFile('resources/biber-cpan-sources.lock.json', 'utf8'));
  assert.equal(
    digest(await fs.readFile(path.join(output, lock.biberLicenseText.sha256 + '.txt'))),
    lock.biberLicenseText.sha256,
  );
  assert.deepEqual(await verifyBiberNotices(output), result);
  assert.deepEqual(await prepareBiberNotices(output), result);
});

test('Biber guard rejects the wrong helper identity and source locks before generating output', async (t) => {
  const { root, output, sources } = await fixture(t, true);
  const indexFile = path.join(sources, 'SOURCES.json');
  const original = await fs.readFile(indexFile);
  for (const change of [
    { compiler: 'Tectonic' },
    { compilerVersion: '9.99' },
    { compilerSourceCommit: '0'.repeat(40) },
    { originalCompilerSha256: '0'.repeat(64) },
  ]) {
    await fs.writeFile(
      indexFile,
      JSON.stringify({ ...JSON.parse(original.toString()), ...change }),
    );
    await assert.rejects(prepareBiberNotices(output, root), /pinned compiler/);
    await assert.rejects(fs.stat(output), { code: 'ENOENT' });
  }
  await fs.writeFile(indexFile, original);
  await fs.appendFile(path.join(root, 'resources/biber-cpan-sources.lock.json'), ' ');
  await assert.rejects(prepareBiberNotices(output, root), /source lock changed/);
  await assert.rejects(fs.stat(output), { code: 'ENOENT' });
});

test('damaged Biber source or installed documents cannot pass the package gate', async (t) => {
  const { root, output, sources } = await fixture(t, true);
  const before = await prepareBiberNotices(output, root);
  const compressed = path.join(sources, 'ORIGINALS.json.gz');
  const original = await fs.readFile(compressed);
  await fs.writeFile(compressed, original.subarray(0, original.length - 1));
  await assert.rejects(prepareBiberNotices(output, root), /Changed compressed/);
  assert.deepEqual(await verifyBiberNotices(output, root), before);
  await fs.writeFile(compressed, original);
  const item = before.records.find((r) => r.path.endsWith('.txt'))!;
  const file = path.join(output, item.path),
    bytes = await fs.readFile(file);
  await fs.writeFile(file, 'different terms');
  await assert.rejects(verifyBiberNotices(output, root), /Changed/);
  await fs.unlink(file);
  await assert.rejects(verifyBiberNotices(output, root), /Incomplete/);
  const outside = path.join(root, 'outside');
  await fs.writeFile(outside, bytes);
  await fs.symlink(outside, file);
  await assert.rejects(prepareBiberNotices(output, root), /Linked/);
  await assert.rejects(verifyBiberNotices(output, root), /Linked/);
  assert.deepEqual(await fs.readFile(outside), bytes);
});
