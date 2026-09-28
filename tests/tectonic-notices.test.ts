import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { prepareTectonicNotices, verifyTectonicNotices } from '../scripts/tectonic-notices';

const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
async function fixture(t: TestContext, copy = false) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'folio-tectonic-notices-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  if (copy) {
    await fs.cp('resources/tectonic-notices', path.join(root, 'resources/tectonic-notices'), {
      recursive: true,
    });
    for (const file of [
      'compiler-build-provenance.lock.json',
      'runtime-license-sources.lock.json',
      'rust-license-notices.lock.json',
      'rust-standard-library.lock.json',
      'native-license-sources.lock.json',
    ])
      await fs.copyFile(path.join('resources', file), path.join(root, 'resources', file));
  }
  return {
    root,
    output: path.join(root, 'output'),
    sources: path.join(root, 'resources/tectonic-notices'),
  };
}

test('packaging expands all verified original Tectonic texts and preserves compiler identity', async (t) => {
  const { output } = await fixture(t);
  const result = await prepareTectonicNotices(output);
  assert.equal(result.compilerVersion, '0.17.0');
  assert.equal(
    result.originalCompilerSha256,
    'b52b5a730e2b0b33087304f7720f649603953f270a6b1c88bb031e1ae01f7f9c',
  );
  assert.equal(result.components, 319);
  assert.equal(result.originalNoticeReferences, 657);
  assert.equal(result.uniqueOriginalTexts, 255);
  assert.equal(result.expandedTextBytes, 921303);
  assert.equal(result.records.length, 257);
  assert.equal(result.completeBinarySbom, false);
  const originalTectonicLicense =
    '814a258f76e420b25cb3c07172eb2b3956f34cefbf0a650413b78e65c425f306';
  assert.equal(
    digest(await fs.readFile(path.join(output, originalTectonicLicense + '.txt'))),
    originalTectonicLicense,
  );
  assert.deepEqual(await verifyTectonicNotices(output), result);
  assert.deepEqual(await prepareTectonicNotices(output), result);
});

test('the Tectonic package gate rejects missing, changed, linked and extra texts', async (t) => {
  const { root, output } = await fixture(t);
  const result = await prepareTectonicNotices(output);
  const name = result.records.find((r) => r.path.endsWith('.txt'))!.path;
  const file = path.join(output, name),
    bytes = await fs.readFile(file);
  await fs.writeFile(file, 'changed');
  await assert.rejects(verifyTectonicNotices(output), /Changed/);
  await fs.unlink(file);
  await assert.rejects(verifyTectonicNotices(output), /Incomplete/);
  const outside = path.join(root, 'outside');
  await fs.writeFile(outside, bytes);
  await fs.symlink(outside, file);
  await assert.rejects(verifyTectonicNotices(output), /Linked/);
  await assert.rejects(prepareTectonicNotices(output), /Linked/);
  await fs.unlink(file);
  await fs.link(outside, file);
  await assert.rejects(verifyTectonicNotices(output), /Linked/);
  await fs.unlink(file);
  await fs.writeFile(file, bytes);
  await fs.writeFile(path.join(output, 'extra'), 'extra');
  await assert.rejects(verifyTectonicNotices(output), /unexpected/);
  await assert.rejects(prepareTectonicNotices(output), /Unexpected/);
  await fs.unlink(path.join(output, 'extra'));
  await fs.symlink(output, path.join(root, 'linked'));
  await assert.rejects(prepareTectonicNotices(path.join(root, 'linked')), /Linked/);
  assert.deepEqual(await verifyTectonicNotices(output), result);
  assert.deepEqual(await fs.readFile(outside), bytes);
});

test('damaged compressed originals preserve the prior generated notice set', async (t) => {
  const { root, sources, output } = await fixture(t, true);
  const before = await prepareTectonicNotices(output, root);
  const file = path.join(sources, 'ORIGINALS.json.gz');
  const bytes = await fs.readFile(file);
  bytes[0] ^= 1;
  await fs.writeFile(file, bytes);
  await assert.rejects(prepareTectonicNotices(output, root), /Changed compressed/);
  assert.deepEqual(await verifyTectonicNotices(output, root), before);
});

test('compiler identity, traversal names and oversized expansion are rejected before writing', async (t) => {
  const { root, sources, output } = await fixture(t, true);
  const file = path.join(sources, 'SOURCES.json'),
    original = await fs.readFile(file, 'utf8');
  const mutations = [
    (index: any) => {
      index.compilerVersion = '0.0.0';
    },
    (index: any) => {
      index.originalCompilerSha256 = '0'.repeat(64);
    },
    (index: any) => {
      index.components[0].notices[0].file = '../outside';
    },
    (index: any) => {
      index.payload.expandedJsonBytes = 32 * 1024 * 1024;
    },
  ];
  for (const mutate of mutations) {
    const index = JSON.parse(original);
    mutate(index);
    await fs.writeFile(file, JSON.stringify(index));
    await assert.rejects(prepareTectonicNotices(output, root), /pinned compiler|Invalid/);
    await assert.rejects(fs.access(output));
  }
  await assert.rejects(fs.access(path.join(root, 'outside')));
  await fs.writeFile(file, original);
  await fs.appendFile(path.join(root, 'resources/native-license-sources.lock.json'), ' ');
  await assert.rejects(prepareTectonicNotices(output, root), /source lock changed/);
  await assert.rejects(fs.access(output));
});

test('per-text checks reject altered originals even when outer payload hashes are updated', async (t) => {
  const { root, sources, output } = await fixture(t, true);
  const indexPath = path.join(sources, 'SOURCES.json'),
    payloadPath = path.join(sources, 'ORIGINALS.json.gz');
  const index = JSON.parse(await fs.readFile(indexPath, 'utf8'));
  const texts = JSON.parse(gunzipSync(await fs.readFile(payloadPath)).toString());
  const first = Object.keys(texts)[0];
  texts[first] = Buffer.from('changed original text').toString('base64');
  const expanded = Buffer.from(JSON.stringify(texts)),
    compressed = gzipSync(expanded);
  index.payload = {
    ...index.payload,
    bytes: compressed.length,
    sha256: digest(compressed),
    expandedJsonBytes: expanded.length,
    expandedJsonSha256: digest(expanded),
  };
  await fs.writeFile(indexPath, JSON.stringify(index));
  await fs.writeFile(payloadPath, compressed);
  await assert.rejects(prepareTectonicNotices(output, root), /Changed Tectonic original text/);
  await assert.rejects(fs.access(output));
});
