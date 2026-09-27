import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { qualificationIdentity } from '../scripts/mac-qualification';

test('native qualification distinguishes runtime, framework and mode changes even when app.asar is unchanged', async (t) => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'folio-qualification-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const runtime = path.join(root, 'Contents/Resources/runtime');
  const framework = path.join(root, 'Contents/Frameworks/helper');
  await fs.mkdir(runtime, { recursive: true });
  await fs.mkdir(path.dirname(framework), { recursive: true });
  await fs.writeFile(path.join(root, 'Contents/Resources/app.asar'), 'Same application code');
  await fs.writeFile(path.join(runtime, 'manifest.json'), 'Original manifest');
  await fs.writeFile(path.join(runtime, 'biber'), 'Original helper');
  await fs.writeFile(framework, 'Framework bytes', { mode: 0o755 });
  const original = await qualificationIdentity(root);
  assert.deepEqual(await qualificationIdentity(root), original);
  await fs.writeFile(path.join(runtime, 'manifest.json'), 'New signed manifest');
  const signed = await qualificationIdentity(root);
  assert.equal(signed.asarSha256, original.asarSha256);
  assert.notEqual(signed.runtimeManifestSha256, original.runtimeManifestSha256);
  assert.notEqual(signed.bundleInventorySha256, original.bundleInventorySha256);
  await fs.writeFile(path.join(runtime, 'manifest.json'), 'Original manifest');
  await fs.appendFile(path.join(runtime, 'biber'), 'Changed without updating manifest');
  const helper = await qualificationIdentity(root);
  assert.equal(helper.asarSha256, original.asarSha256);
  assert.equal(helper.runtimeManifestSha256, original.runtimeManifestSha256);
  assert.notEqual(helper.bundleInventorySha256, original.bundleInventorySha256);
  await fs.writeFile(path.join(runtime, 'biber'), 'Original helper');
  await fs.appendFile(framework, 'Changed signature');
  assert.notEqual(
    (await qualificationIdentity(root)).bundleInventorySha256,
    original.bundleInventorySha256,
  );
  await fs.writeFile(framework, 'Framework bytes');
  await fs.chmod(framework, 0o644);
  assert.notEqual(
    (await qualificationIdentity(root)).bundleInventorySha256,
    original.bundleInventorySha256,
  );
});
