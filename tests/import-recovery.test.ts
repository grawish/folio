import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { zipSync } from 'fflate';
import { ImportTransactions, writeImportFile } from '../electron/core/import-transactions';
import { ProjectImporter } from '../electron/core/project-import';

const source = '\\documentclass{article}\n\\begin{document}Recovered import\\end{document}';
async function fixture(t: TestContext) {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'folio-import-recovery-')),
  );
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const data = path.join(root, 'app'),
    parent = path.join(root, 'imports'),
    zip = path.join(root, 'source.zip');
  await fs.mkdir(parent);
  const originals = new Map([
    ['main.tex', Buffer.from(source)],
    ['sections/details.tex', Buffer.from('Unchanged section')],
    ['assets/picture.png', Buffer.from([0, 255, 20, 4])],
  ]);
  await fs.writeFile(zip, zipSync(Object.fromEntries(originals)));
  return { root, data, parent, zip, originals, recovery: new ImportTransactions(data) };
}
async function crash(f: Awaited<ReturnType<typeof fixture>>, boundary: string) {
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', 'tests/fixtures/import-crash.ts', f.data, f.parent, f.zip, boundary],
    { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let output = '',
    stderr = '';
  child.stdout.on('data', (data) => {
    output += data;
    if (output.includes('READY-TO-KILL')) child.kill('SIGKILL');
  });
  child.stderr.on('data', (data) => {
    stderr += data;
  });
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('Crash boundary timed out: ' + stderr));
    }, 15000);
    child.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on('exit', (_code, signal) => {
      clearTimeout(timeout);
      if (signal === 'SIGKILL' && output.includes('READY-TO-KILL')) resolve();
      else reject(new Error('Unexpected child exit: ' + stderr));
    });
  });
  const [item] = await f.recovery.list();
  assert.ok(item);
  return item;
}

test('actual process interruption preserves staged, partial and completed imports for explicit recovery', async (t) => {
  for (const boundary of ['staging', 'prepared', 'directory', 'partial', 'file', 'complete']) {
    const f = await fixture(t);
    const before = await fs.readFile(f.zip);
    const item = await crash(f, boundary);
    assert.equal((await f.recovery.list()).length, 1);
    if (boundary === 'staging') {
      assert.equal(item.state, 'preparing');
      assert.equal(item.canResume, false);
      assert.equal(item.hasFolder, false);
      assert.deepEqual(await fs.readdir(f.parent), []);
      await f.recovery.discard(item.id);
    } else {
      assert.equal(item.canResume, true, item.message);
      const { directory } = await new ImportTransactions(f.data).resume(item.id);
      for (const [name, data] of f.originals)
        assert.deepEqual(
          await fs.readFile(path.join(directory, name)),
          data,
          boundary + ': ' + name,
        );
      assert.equal((await f.recovery.list())[0].state, 'complete');
      const metadata = await fs.readFile(path.join(directory, 'resume.project.json'));
      assert.equal((await f.recovery.resume(item.id)).directory, directory);
      assert.deepEqual(await fs.readFile(path.join(directory, 'resume.project.json')), metadata);
      await f.recovery.acknowledge(item.id);
      assert.equal(await fs.readFile(path.join(directory, 'main.tex'), 'utf8'), source);
    }
    assert.deepEqual(await fs.readFile(f.zip), before);
    assert.equal((await f.recovery.list()).length, 0);
  }
});

test('interruption after moving a copy to Trash never recreates it and cleanup can finish', async (t) => {
  const f = await fixture(t);
  const item = await crash(f, 'discarded');
  assert.equal(item.canResume, false);
  assert.equal(item.canDiscard, true);
  assert.equal(item.state, 'discarding');
  assert.equal(item.hasFolder, false);
  await assert.rejects(f.recovery.resume(item.id), /discard/);
  await f.recovery.discard(item.id, async () => {
    throw new Error('No folder should remain to trash');
  });
  assert.deepEqual(await fs.readdir(f.parent), ['test-trash']);
  assert.equal(await fs.readFile(path.join(f.parent, 'test-trash/main.tex'), 'utf8'), source);
  assert.equal((await f.recovery.list()).length, 0);
});

test('outside edits, removal of completed files, unexpected files and links prevent resume and removal', async (t) => {
  for (const change of ['edit', 'truncate', 'remove', 'extra', 'symlink', 'hardlink']) {
    const f = await fixture(t);
    const item = await crash(f, 'file');
    const folder = item.directory!,
      filename = path.join(folder, 'main.tex');
    const outside = path.join(f.root, 'outside.tex');
    await fs.writeFile(outside, source);
    if (change === 'edit') await fs.writeFile(filename, 'User edit after the crash');
    if (change === 'truncate') await fs.writeFile(filename, source.slice(0, 12));
    if (change === 'remove') await fs.unlink(filename);
    if (change === 'extra') await fs.writeFile(path.join(folder, 'keep.txt'), 'User file');
    if (change === 'symlink' || change === 'hardlink') {
      await fs.unlink(filename);
      if (change === 'symlink') await fs.symlink(outside, filename);
      else await fs.link(outside, filename);
    }
    const blocked = (await f.recovery.list())[0];
    assert.equal(blocked.canResume, false, change);
    assert.equal(blocked.canDiscard, false, change);
    await assert.rejects(f.recovery.resume(item.id));
    await assert.rejects(f.recovery.discard(item.id));
    assert.equal(await fs.readFile(outside, 'utf8'), source);
    const contents = await fs.readdir(folder);
    await f.recovery.forget(item.id);
    assert.deepEqual(await fs.readdir(folder), contents);
  }
});

test('replaced destination and parent directories are never adopted or removed', async (t) => {
  for (const replace of ['destination', 'parent']) {
    const f = await fixture(t);
    const item = await crash(f, 'file');
    const location = replace === 'parent' ? f.parent : item.directory!;
    await fs.rename(location, location + '-original');
    await fs.mkdir(location);
    await fs.writeFile(path.join(location, 'keep.txt'), 'Unrelated files');
    await assert.rejects(f.recovery.resume(item.id), /replaced/);
    await assert.rejects(f.recovery.discard(item.id), /replaced/);
    await f.recovery.forget(item.id);
    assert.equal(await fs.readFile(path.join(location, 'keep.txt'), 'utf8'), 'Unrelated files');
  }
});

test('damaged staging data or records stay visible and dismissing touches only recovery storage', async (t) => {
  for (const damage of ['payload', 'journal', 'linked-record']) {
    const f = await fixture(t);
    const item = await crash(f, 'file');
    const record = path.join(f.data, 'import-transactions', item.id);
    const outside = path.join(f.root, 'outside');
    await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, 'keep.txt'), 'Keep');
    if (damage === 'payload') await fs.writeFile(path.join(record, 'payload/0'), 'Damaged');
    if (damage === 'journal') await fs.writeFile(path.join(record, 'journal.json'), '{broken');
    if (damage === 'linked-record') {
      await fs.rm(record, { recursive: true });
      await fs.symlink(outside, record);
    }
    const blocked = (await f.recovery.list())[0];
    assert.equal(blocked.canResume, false);
    assert.equal(blocked.canDiscard, false);
    await assert.rejects(f.recovery.resume(item.id));
    await assert.rejects(f.recovery.discard(item.id));
    await f.recovery.forget(item.id);
    assert.equal(await fs.readFile(path.join(item.directory!, 'main.tex'), 'utf8'), source);
    assert.equal(await fs.readFile(path.join(outside, 'keep.txt'), 'utf8'), 'Keep');
  }
});

test('ordinary partial write failure removes only its proven new copy and retains the ZIP', async (t) => {
  const f = await fixture(t);
  const importer = new ProjectImporter(f.data, async (filename, data) => {
    await writeImportFile(filename, data.subarray(0, 5));
    throw new Error('Injected partial write failure');
  });
  const preview = await importer.prepare(f.zip);
  const original = await fs.readFile(f.zip);
  await assert.rejects(
    importer.finish(preview.token, 'main.tex', f.parent),
    /partial write failure/,
  );
  assert.deepEqual(await fs.readdir(f.parent), []);
  assert.deepEqual(await f.recovery.list(), []);
  assert.deepEqual(await fs.readFile(f.zip), original);
});

test('a nonempty collision is never used; recovery admission bounds accumulated copies', async (t) => {
  const f = await fixture(t),
    id = randomUUID();
  await f.recovery.create(id, 'Resume', 'main.tex', f.parent, f.originals);
  const folder = (await f.recovery.list())[0].directory!;
  await fs.mkdir(folder);
  await fs.writeFile(path.join(folder, 'main.tex'), 'Existing project');
  await assert.rejects(f.recovery.resume(id), /unrecognized/);
  await assert.rejects(f.recovery.discard(id), /unrecognized/);
  await f.recovery.forget(id);
  assert.equal(await fs.readFile(path.join(folder, 'main.tex'), 'utf8'), 'Existing project');
  for (let i = 0; i < 10; i++)
    await f.recovery.create(randomUUID(), 'Resume', 'main.tex', f.parent, f.originals);
  await assert.rejects(
    f.recovery.create(randomUUID(), 'Resume', 'main.tex', f.parent, f.originals),
    /Review interrupted/,
  );
  assert.deepEqual(await fs.readdir(f.parent), [path.basename(folder)]);
  await assert.rejects(f.recovery.forget('../outside'), /recovery list/);
});

test('a refused removal leaves the import resumable; Unicode names keep valid folder names', async (t) => {
  const f = await fixture(t),
    id = randomUUID();
  await f.recovery.create(id, 'A' + '𐐀'.repeat(59), 'main.tex', f.parent, f.originals);
  const { directory } = await f.recovery.resume(id);
  assert.equal(await fs.realpath(directory), directory);
  assert.ok(Buffer.byteLength(path.basename(directory)) <= 255);
  let removed = false;
  await assert.rejects(
    f.recovery.discard(
      id,
      async () => {
        removed = true;
      },
      () => {
        throw new Error('This imported project is open.');
      },
    ),
    /project is open/,
  );
  assert.equal(removed, false);
  const [item] = await f.recovery.list();
  assert.equal(item.state, 'complete');
  assert.equal(item.canResume, true);
  assert.equal(item.hasFolder, true);
  assert.equal((await f.recovery.resume(id)).directory, directory);
  await f.recovery.acknowledge(id);
  assert.equal(await fs.readFile(path.join(directory, 'main.tex'), 'utf8'), source);
});
