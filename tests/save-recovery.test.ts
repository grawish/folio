import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { SaveTransactions, fileDigest, readTarget } from '../electron/core/save-transactions';
import type { RecoveryVersion } from '../src/shared/save-recovery';

async function killed(script: string, args: string[]) {
  const child = spawn(process.execPath, ['--import', 'tsx', script, ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '',
    error = '';
  child.stdout.on('data', (value) => {
    output += value;
    if (output.includes('READY-TO-KILL')) child.kill('SIGKILL');
  });
  child.stderr.on('data', (value) => {
    error += value;
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('Crash fixture timed out: ' + error));
    }, 15_000);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (_code, signal) => {
      clearTimeout(timer);
      if (signal === 'SIGKILL' && output.includes('READY-TO-KILL')) resolve();
      else reject(new Error('Unexpected crash fixture exit: ' + error));
    });
  });
}
async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'folio-recovery-')));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const data = path.join(base, 'data'),
    root = path.join(base, 'project');
  await fs.mkdir(root);
  await fs.mkdir(data);
  await fs.writeFile(path.join(root, 'main.tex'), 'Before source');
  await fs.writeFile(path.join(root, 'gone.tex'), 'Before deletion');
  await fs.writeFile(path.join(root, 'resume.folio'), Buffer.from([0, 128, 3]));
  await fs.chmod(path.join(root, 'main.tex'), 0o640);
  const input = path.join(base, 'changes.json');
  await fs.writeFile(
    input,
    JSON.stringify([
      { path: 'main.tex', content: 'Attempted source' },
      { path: 'gone.tex', content: null },
      { path: 'sections/new.tex', content: 'Attempted addition' },
      { path: 'resume.folio', content: 'Attempted history' },
    ]),
  );
  await killed('tests/fixtures/save-crash.ts', [data, root, input, 'applying']);
  await fs.writeFile(path.join(root, 'main.tex'), 'Outside edit');
  const transaction = new SaveTransactions(data),
    review = (await transaction.review(root))!;
  const directory = path.join(data, 'save-transactions', fileDigest(root));
  const choose = (version: RecoveryVersion) =>
    review.files.map((file) => ({ path: file.path, version }));
  return { base, root, data, directory, transaction, review, choose };
}

test('review distinguishes outside edits, deletions, additions and binary copies without changing files', async (t) => {
  const f = await fixture(t);
  assert.equal(f.review.files[0].changedAfterward, true);
  assert.equal(f.review.files[1].versions.after.exists, false);
  assert.equal(f.review.files[2].versions.before.exists, false);
  assert.equal(
    (await f.transaction.reviewText(f.root, f.review.token, 'main.tex', 'before')).text,
    'Before source',
  );
  assert.equal(
    (await f.transaction.reviewText(f.root, f.review.token, 'resume.folio', 'before')).text,
    null,
  );
  assert.equal((await readTarget(f.root, 'main.tex'))?.toString(), 'Outside edit');
  assert.equal(await readTarget(f.root, 'gone.tex'), null);
});

test('mixed choices restore exact bytes and retain every available version and original journal', async (t) => {
  const f = await fixture(t),
    choices = f.choose('before');
  choices[0].version = 'current';
  choices[2].version = 'after';
  const archive = await f.transaction.resolve(f.root, f.review.token, choices);
  assert.equal((await readTarget(f.root, 'main.tex'))?.toString(), 'Outside edit');
  assert.equal((await readTarget(f.root, 'gone.tex'))?.toString(), 'Before deletion');
  assert.equal((await readTarget(f.root, 'sections/new.tex'))?.toString(), 'Attempted addition');
  assert.deepEqual(await readTarget(f.root, 'resume.folio'), Buffer.from([0, 128, 3]));
  for (const data of [
    'Before source',
    'Attempted source',
    'Outside edit',
    'Before deletion',
    'Attempted addition',
    'Attempted history',
  ])
    assert.equal((await readTarget(archive, 'kept-' + fileDigest(data)))?.toString(), data);
  assert.ok(await readTarget(archive, 'journal.json'));
  assert.equal((await fs.stat(archive)).mode & 0o777, 0o700);
  assert.equal(
    (await fs.stat(path.join(archive, 'kept-' + fileDigest('Outside edit')))).mode & 0o777,
    0o600,
  );
  assert.equal(await f.transaction.recover(f.root), 'none');
  assert.equal(await f.transaction.review(f.root), null);
  await f.transaction.commit(f.root, [
    { path: 'main.tex', before: Buffer.from('Outside edit'), data: Buffer.from('Later save') },
  ]);
  assert.equal(
    (await readTarget(archive, 'kept-' + fileDigest('Outside edit')))?.toString(),
    'Outside edit',
  );
});

test('all-before and all-attempted choices handle deleted and never-applied files', async (t) => {
  for (const version of ['before', 'after'] as const) {
    const f = await fixture(t);
    await f.transaction.resolve(f.root, f.review.token, f.choose(version));
    assert.equal(
      (await readTarget(f.root, 'main.tex'))?.toString(),
      version === 'before' ? 'Before source' : 'Attempted source',
    );
    assert.equal((await fs.stat(path.join(f.root, 'main.tex'))).mode & 0o777, 0o640);
    assert.equal(
      (await readTarget(f.root, 'gone.tex'))?.toString() ?? null,
      version === 'before' ? 'Before deletion' : null,
    );
    assert.equal(
      (await readTarget(f.root, 'sections/new.tex'))?.toString() ?? null,
      version === 'before' ? null : 'Attempted addition',
    );
  }
});

test('stale review, changed backup or permission, invalid choices and symlinks leave disk and journal unchanged', async (t) => {
  const f = await fixture(t),
    original = await readTarget(f.directory, 'journal.json');
  const invalid = [
    f.choose('before').slice(1),
    [...f.choose('before').slice(1), f.choose('before')[1]],
    [{ path: '../escape', version: 'before' }, ...f.choose('before').slice(1)],
  ];
  for (const choices of invalid)
    await assert.rejects(f.transaction.resolve(f.root, f.review.token, choices as any));
  await fs.chmod(path.join(f.root, 'main.tex'), 0o600);
  await assert.rejects(
    f.transaction.resolve(f.root, f.review.token, f.choose('before')),
    /changed/,
  );
  await fs.chmod(path.join(f.root, 'main.tex'), 0o640);
  await fs.writeFile(path.join(f.root, 'main.tex'), 'Even newer outside edit');
  await assert.rejects(
    f.transaction.resolve(f.root, f.review.token, f.choose('before')),
    /changed/,
  );
  await assert.rejects(
    f.transaction.reviewText(f.root, f.review.token, 'main.tex', 'before'),
    /changed/,
  );
  await fs.writeFile(path.join(f.root, 'main.tex'), 'Outside edit');
  await fs.writeFile(path.join(f.directory, 'old-0'), 'Damaged copy');
  await assert.rejects(
    f.transaction.resolve(f.root, f.review.token, f.choose('before')),
    /changed/,
  );
  const newer = (await f.transaction.review(f.root))!;
  assert.equal(newer.files[0].versions.before.available, false);
  await assert.rejects(
    f.transaction.resolve(f.root, newer.token, f.choose('before')),
    /missing or damaged/,
  );
  assert.deepEqual(await readTarget(f.directory, 'journal.json'), original);
  assert.equal(await readTarget(f.directory, 'resolution.json'), null);
  await fs.unlink(path.join(f.root, 'main.tex'));
  await fs.symlink(path.join(f.base, 'outside'), path.join(f.root, 'main.tex'));
  await assert.rejects(f.transaction.review(f.root), /without symbolic links/);
});

test('a damaged original backup can be bypassed explicitly while its bytes remain archived', async (t) => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.directory, 'old-0'), 'Damaged copy');
  const review = (await f.transaction.review(f.root))!;
  const archive = await f.transaction.resolve(f.root, review.token, f.choose('current'));
  assert.equal((await readTarget(archive, 'old-0'))?.toString(), 'Damaged copy');
  assert.equal((await readTarget(f.root, 'main.tex'))?.toString(), 'Outside edit');
});

for (const stage of ['prepared', 'applying', 'completed', 'archived'])
  test(`a real process kill at resolution ${stage} resumes choices and retains copies`, async (t) => {
    const f = await fixture(t);
    await killed('tests/fixtures/save-recovery-crash.ts', [f.data, f.root, stage]);
    assert.equal(
      await new SaveTransactions(f.data).recover(f.root),
      stage === 'archived' ? 'none' : 'resolved',
    );
    assert.equal((await readTarget(f.root, 'main.tex'))?.toString(), 'Before source');
    assert.equal((await readTarget(f.root, 'gone.tex'))?.toString(), 'Before deletion');
    assert.equal(await readTarget(f.root, 'sections/new.tex'), null);
    const names = await fs.readdir(path.join(f.data, 'save-recovery-copies'));
    assert.equal(names.length, 1);
    assert.equal(
      (
        await readTarget(
          path.join(f.data, 'save-recovery-copies', names[0]),
          'kept-' + fileDigest('Outside edit'),
        )
      )?.toString(),
      'Outside edit',
    );
    assert.equal(await f.transaction.recover(f.root), 'none');
  });

test('outside edits during partial recovery stop before more writes and allow a fresh decision', async (t) => {
  const f = await fixture(t);
  await killed('tests/fixtures/save-recovery-crash.ts', [f.data, f.root, 'applying']);
  await fs.writeFile(path.join(f.root, 'main.tex'), 'Edited during recovery');
  await assert.rejects(f.transaction.recover(f.root), /changed during recovery/);
  assert.equal(await readTarget(f.root, 'gone.tex'), null);
  const review = (await f.transaction.review(f.root))!;
  const choices = f.choose('before');
  choices[0].version = 'current';
  const archive = await f.transaction.resolve(f.root, review.token, choices);
  assert.equal((await readTarget(f.root, 'main.tex'))?.toString(), 'Edited during recovery');
  assert.equal((await readTarget(f.root, 'gone.tex'))?.toString(), 'Before deletion');
  for (const text of ['Outside edit', 'Edited during recovery'])
    assert.equal((await readTarget(archive, 'kept-' + fileDigest(text)))?.toString(), text);
  assert.equal(
    (await fs.readdir(archive)).filter((name) => name.startsWith('decision-')).length,
    2,
  );
});

test('post-commit outside edits survive archive cleanup; malformed decisions never trigger automatic rollback', async (t) => {
  const f = await fixture(t);
  await killed('tests/fixtures/save-recovery-crash.ts', [f.data, f.root, 'completed']);
  await fs.writeFile(path.join(f.root, 'main.tex'), 'After completed recovery');
  assert.equal(await f.transaction.recover(f.root), 'resolved');
  assert.equal((await readTarget(f.root, 'main.tex'))?.toString(), 'After completed recovery');
  const g = await fixture(t);
  await fs.writeFile(path.join(g.directory, 'resolution.json'), '{bad');
  await assert.rejects(g.transaction.recover(g.root), /choices could not be read/);
  await assert.rejects(g.transaction.review(g.root), /choices could not be read/);
  assert.equal((await readTarget(g.root, 'main.tex'))?.toString(), 'Outside edit');
});

test('missing retained copies and blocked archive destinations keep the journal for another attempt', async (t) => {
  const f = await fixture(t);
  await killed('tests/fixtures/save-recovery-crash.ts', [f.data, f.root, 'prepared']);
  await fs.unlink(path.join(f.directory, 'kept-' + fileDigest('Before deletion')));
  await assert.rejects(f.transaction.recover(f.root), /copy is missing or damaged/);
  assert.equal((await readTarget(f.root, 'main.tex'))?.toString(), 'Outside edit');
  const review = (await f.transaction.review(f.root))!;
  const outside = path.join(f.base, 'archive-link-target');
  await fs.mkdir(outside);
  await fs.symlink(outside, path.join(f.data, 'save-recovery-copies'));
  await assert.rejects(
    f.transaction.resolve(f.root, review.token, f.choose('before')),
    /real directory/,
  );
  assert.deepEqual(await fs.readdir(outside), []);
  await fs.unlink(path.join(f.data, 'save-recovery-copies'));
  assert.equal(await f.transaction.recover(f.root), 'resolved');
});

test('manual recovery refuses malformed journals and unsafe parent folders', async (t) => {
  const f = await fixture(t),
    bytes = (await readTarget(f.directory, 'journal.json'))!;
  const original = JSON.parse(bytes.toString());
  for (const bad of [
    { ...original, nonce: undefined },
    { ...original, entries: [null] },
    { ...original, entries: [{ ...original.entries[0], before: 123 }] },
  ]) {
    await fs.writeFile(path.join(f.directory, 'journal.json'), JSON.stringify(bad));
    await assert.rejects(f.transaction.review(f.root), /Invalid interrupted save/);
    await assert.rejects(f.transaction.recover(f.root), /Invalid interrupted save/);
    assert.equal((await readTarget(f.root, 'main.tex'))?.toString(), 'Outside edit');
  }
  await fs.writeFile(path.join(f.directory, 'journal.json'), bytes);
  await fs.symlink(f.base, path.join(f.root, 'sections'));
  await assert.rejects(
    f.transaction.resolve(f.root, f.review.token, f.choose('before')),
    /without symbolic links/,
  );
  assert.equal(await readTarget(f.directory, 'resolution.json'), null);
});

test('text previews are bounded; invalid UTF-8 and binary copies do not become replacement text', async (t) => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.root, 'main.tex'), 'x'.repeat(70_000));
  let review = (await f.transaction.review(f.root))!;
  assert.deepEqual(await f.transaction.reviewText(f.root, review.token, 'main.tex', 'current'), {
    text: 'x'.repeat(64_000),
    truncated: true,
  });
  const bytes = Buffer.from([0xff, 0x80, 0x99]);
  await fs.writeFile(path.join(f.root, 'main.tex'), bytes);
  review = (await f.transaction.review(f.root))!;
  assert.deepEqual(await f.transaction.reviewText(f.root, review.token, 'main.tex', 'current'), {
    text: null,
    truncated: false,
  });
  const archive = await f.transaction.resolve(f.root, review.token, f.choose('current'));
  assert.deepEqual(await readTarget(f.root, 'main.tex'), bytes);
  assert.deepEqual(await readTarget(archive, 'kept-' + fileDigest(bytes)), bytes);
});

test('losing an unselected retained outside edit prevents recovery from overwriting its last copy', async (t) => {
  const f = await fixture(t);
  await killed('tests/fixtures/save-recovery-crash.ts', [f.data, f.root, 'prepared']);
  await fs.unlink(path.join(f.directory, 'kept-' + fileDigest('Outside edit')));
  await assert.rejects(
    f.transaction.recover(f.root),
    /retained recovery copy is missing or damaged/,
  );
  assert.equal((await readTarget(f.root, 'main.tex'))?.toString(), 'Outside edit');
  assert.equal(await readTarget(f.root, 'gone.tex'), null);
  const review = (await f.transaction.review(f.root))!;
  const archive = await f.transaction.resolve(f.root, review.token, f.choose('before'));
  assert.equal(
    (await readTarget(archive, 'kept-' + fileDigest('Outside edit')))?.toString(),
    'Outside edit',
  );
});
