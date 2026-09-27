import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { prepareElectronNotices, verifyElectronNotices } from '../scripts/electron-notices';

async function fixture(t: TestContext, copySources = false) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'folio-electron-notices-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  if (copySources) {
    await fs.cp('resources/electron-notices', path.join(root, 'resources/electron-notices'), {
      recursive: true,
    });
    for (const name of ['package.json', 'package-lock.json'])
      await fs.copyFile(name, path.join(root, name));
  }
  return { root, output: path.join(root, 'output') };
}

test('packaging expands both complete upstream Electron notices with exact identities', async (t) => {
  const { output } = await fixture(t);
  const result = await prepareElectronNotices(output);
  assert.equal(result.electronVersion, '44.4.5');
  assert.equal(result.originalNoticeFiles, 2);
  assert.equal(result.records.length, 4);
  assert.equal(result.records.find((r) => r.path === 'LICENSES.chromium.html')?.bytes, 20111209);
  assert.equal(result.completeBinarySbom, false);
  assert.deepEqual(await verifyElectronNotices(output), result);
  assert.deepEqual(await prepareElectronNotices(output), result);
});

test('the package gate rejects missing, changed, linked and extra original notices', async (t) => {
  const { root, output } = await fixture(t);
  await prepareElectronNotices(output);
  for (const name of ['LICENSE', 'LICENSES.chromium.html', 'SOURCES.json', 'README.md']) {
    const file = path.join(output, name),
      original = await fs.readFile(file);
    const altered = Buffer.from(original);
    altered[0] ^= 1;
    await fs.writeFile(file, altered);
    await assert.rejects(verifyElectronNotices(output), /Changed/);
    await fs.unlink(file);
    await assert.rejects(verifyElectronNotices(output), /Incomplete/);
    const outside = path.join(root, 'outside');
    await fs.writeFile(outside, original);
    await fs.symlink(outside, file);
    await assert.rejects(verifyElectronNotices(output), /Linked/);
    await assert.rejects(prepareElectronNotices(output), /Linked/);
    await fs.unlink(file);
    await fs.link(outside, file);
    await assert.rejects(verifyElectronNotices(output), /Linked/);
    await fs.unlink(file);
    await fs.writeFile(file, original);
  }
  await fs.writeFile(path.join(output, 'unexpected'), 'extra');
  await assert.rejects(verifyElectronNotices(output), /unexpected/);
  await assert.rejects(prepareElectronNotices(output), /Unexpected/);
  await fs.unlink(path.join(output, 'unexpected'));
  await fs.symlink(output, path.join(root, 'linked'));
  await assert.rejects(verifyElectronNotices(path.join(root, 'linked')), /Linked/);
  await assert.rejects(prepareElectronNotices(path.join(root, 'linked')), /Linked/);
  await verifyElectronNotices(output);
});

test('a damaged compressed source leaves the previous generated notice set unchanged', async (t) => {
  const { root, output } = await fixture(t, true);
  const before = await prepareElectronNotices(output, root);
  const file = path.join(root, 'resources/electron-notices/LICENSES.chromium.html.gz');
  const original = await fs.readFile(file);
  const changed = Buffer.from(original);
  changed[0] ^= 1;
  await fs.writeFile(file, changed);
  await assert.rejects(prepareElectronNotices(output, root), /Changed compressed/);
  assert.deepEqual(await verifyElectronNotices(output, root), before);
  await fs.writeFile(file, original);
  assert.deepEqual(await prepareElectronNotices(output, root), before);
});

test('dependency upgrades and malformed source records cannot reuse old notices', async (t) => {
  const { root, output } = await fixture(t, true);
  const source = path.join(root, 'resources/electron-notices/SOURCES.json');
  const original = JSON.parse(await fs.readFile(source, 'utf8'));
  const mutate = async (edit: (value: typeof original) => void) => {
    const value = structuredClone(original);
    edit(value);
    await fs.writeFile(source, JSON.stringify(value));
    await assert.rejects(
      prepareElectronNotices(output, root),
      /pinned dependency|Invalid original/,
    );
    await assert.rejects(fs.access(output));
  };
  await mutate((j) => {
    j.electronVersion = '44.4.6';
  });
  await mutate((j) => {
    j.platform = 'linux-x64';
  });
  await mutate((j) => {
    j.noticeFiles[1].file = '../outside';
  });
  await mutate((j) => {
    j.noticeFiles[1].bytes = 64 * 1024 * 1024;
  });
  await mutate((j) => {
    j.noticeFiles.pop();
  });
  await fs.writeFile(source, JSON.stringify(original));
  const packagePath = path.join(root, 'package.json');
  const pkg = JSON.parse(await fs.readFile(packagePath, 'utf8'));
  pkg.devDependencies.electron = '44.4.6';
  await fs.writeFile(packagePath, JSON.stringify(pkg));
  await assert.rejects(prepareElectronNotices(output, root), /pinned dependency/);
});
