import { spawn } from 'node:child_process';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { unzipSync } from 'fflate';
import { CompilerMigration } from '../electron/core/compiler-migration';
import { WorkspaceStore } from '../electron/core/workspace';
import { ProjectStore } from '../electron/core/project';
import type { Project, BuildResult } from '../src/shared/types';
import type { RuntimePin } from '../src/shared/runtime';

const old: RuntimePin = {
  engine: 'tectonic',
  version: '0.16.0',
  bundle: 'old-bundle',
  id: 'a'.repeat(64),
  platform: `${process.platform}-${process.arch}`,
};
const target: RuntimePin = { ...old, version: '0.17.0', bundle: 'new-bundle', id: 'b'.repeat(64) };
const project: Project = {
  id: 'resume',
  name: 'Original resume',
  mainFile: 'main.tex',
  revision: 3,
  runtime: old,
  files: [{ path: 'main.tex', content: 'My draft' }],
  removedFiles: [
    {
      id: 'removed',
      path: 'old.tex',
      content: 'Keep this copy',
      removedAt: '2026-09-25',
      reason: 'removed',
    },
  ],
};
const pdf = (label: string) => Buffer.from(`%PDF-1.7\n${label}\n%%EOF`);
async function fixture(t: { after(fn: () => Promise<unknown>): void }) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'folio-migration-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const workspace = new WorkspaceStore(root),
    store = new ProjectStore(root);
  const state = {
    assets: new Map([['portrait.png', Buffer.from('portrait bytes')]]),
    diskChanged: false,
    failRecovery: false,
    beforeUnavailable: false,
    failedBuild: false,
    cancelCount: 0,
    commits: 0,
  };
  const compile = async (p: Project): Promise<BuildResult> => ({
    projectId: p.id,
    revision: p.revision,
    status:
      state.failedBuild || (state.beforeUnavailable && p.runtime?.id === old.id)
        ? 'error'
        : 'success',
    runtimeUnavailable: state.beforeUnavailable && p.runtime?.id === old.id,
    pdf: state.failedBuild ? undefined : pdf(p.runtime?.id === old.id ? 'before' : 'after'),
    durationMs: 1,
    diagnostics: [],
    log: state.failedBuild ? 'fixture build failed' : '',
  });
  const deps = {
    target: () => target,
    assets: async () => state.assets,
    checkDisk: async () => {
      if (state.diskChanged) throw new Error('Outside change');
    },
    compile,
    cancel: async () => {
      state.cancelCount++;
    },
    recover: async (p: Project) => {
      if (state.failRecovery) throw new Error('Recovery write failed');
      await store.recover(p);
      state.commits++;
    },
    workspace,
  };
  const manager = new CompilerMigration(path.join(root, 'backups'), deps);
  return { root, workspace, store, state, deps, manager };
}

test('compiler comparison durably backs up source, assets, old pin and history before explicit application', async (t) => {
  const f = await fixture(t),
    id = randomUUID();
  await f.workspace.checkpoint(project, pdf('earlier saved PDF'), 'Earlier');
  const comparison = await f.manager.prepare(id, project);
  assert.equal(comparison.baseline, 'rebuilt');
  assert.equal(f.state.commits, 0);
  assert.equal(await f.store.loadRecovery(), null);
  assert.deepEqual(Buffer.from(comparison.before), pdf('before'));
  assert.deepEqual(Buffer.from(comparison.after), pdf('after'));
  const backup = unzipSync(await fs.readFile(await f.manager.backupPath(project.id, id)));
  const manifest = JSON.parse(Buffer.from(backup['resume.project.json']).toString());
  assert.deepEqual(manifest.runtime, old);
  assert.notEqual(manifest.id, project.id);
  assert.equal(Buffer.from(backup['main.tex']).toString(), 'My draft');
  assert.equal(Buffer.from(backup['portrait.png']).toString(), 'portrait bytes');
  assert.match(Buffer.from(backup['resume.trash']).toString(), /Keep this copy/);
  const history = unzipSync(backup['resume.folio']);
  assert.equal(JSON.parse(Buffer.from(history['state.json']).toString()).projectId, manifest.id);
  const applied = await f.manager.apply(id, project);
  assert.deepEqual(applied.project.runtime, target);
  assert.equal(applied.project.revision, project.revision + 1);
  assert.deepEqual(applied.project.files, project.files);
  assert.deepEqual((await f.store.loadRecovery())?.runtime, target);
  assert.equal(f.state.commits, 1);
  assert.ok(applied.build.versionId);
  const restarted = new CompilerMigration(path.join(f.root, 'backups'), f.deps);
  assert.equal((await restarted.backups(project.id)).length, 1);
  assert.equal(
    await restarted.backupPath(project.id, id),
    await f.manager.backupPath(project.id, id),
  );
});

test('source, name, revision, compiler and asset changes reject stale compiler comparisons', async (t) => {
  const f = await fixture(t);
  for (const change of [
    { name: 'Renamed' },
    { revision: 4 },
    { files: [{ path: 'main.tex', content: 'Newer edit' }] },
    { runtime: target },
  ]) {
    const id = randomUUID();
    await f.manager.prepare(id, project);
    await assert.rejects(() => f.manager.apply(id, { ...project, ...change }), /resume changed/);
    await f.manager.cancel(id);
  }
  const id = randomUUID();
  await f.manager.prepare(id, project);
  f.state.assets = new Map([['portrait.png', Buffer.from('new portrait')]]);
  await assert.rejects(() => f.manager.apply(id, project), /assets changed/);
  assert.equal(f.state.commits, 0);
  assert.equal(await f.store.loadRecovery(), null);
});

test('outside changes, failed recovery and damaged backup keep the recorded compiler', async (t) => {
  const f = await fixture(t),
    id = randomUUID();
  await f.manager.prepare(id, project);
  f.state.diskChanged = true;
  await assert.rejects(() => f.manager.apply(id, project), /Outside change/);
  f.state.diskChanged = false;
  f.state.failRecovery = true;
  await assert.rejects(() => f.manager.apply(id, project), /Recovery write failed/);
  f.state.failRecovery = false;
  await fs.writeFile(await f.manager.backupPath(project.id, id), 'damaged backup');
  await assert.rejects(() => f.manager.apply(id, project), /integrity check/);
  assert.equal(f.state.commits, 0);
  assert.equal(await f.store.loadRecovery(), null);
});

test('an unavailable old compiler uses only a saved PDF matching the source and recorded pin', async (t) => {
  const f = await fixture(t);
  f.state.beforeUnavailable = true;
  await f.workspace.checkpoint({ ...project, runtime: target }, pdf('wrong compiler'), 'Wrong');
  await assert.rejects(() => f.manager.prepare(randomUUID(), project), /no saved PDF matching/);
  await f.workspace.checkpoint(project, pdf('matching old PDF'), 'Matching');
  const comparison = await f.manager.prepare(randomUUID(), project);
  assert.equal(comparison.baseline, 'saved-pdf');
  assert.deepEqual(Buffer.from(comparison.before), pdf('matching old PDF'));
  assert.equal(f.state.commits, 0);
});

test('failed builds do not substitute a saved PDF for actual TeX errors or change the selected compiler', async (t) => {
  const f = await fixture(t);
  await f.workspace.checkpoint(project, pdf('saved'), 'Saved');
  f.state.failedBuild = true;
  await assert.rejects(
    () => f.manager.prepare(randomUUID(), project),
    /recorded compiler could not build/,
  );
  assert.equal(f.manager.active, false);
  assert.deepEqual(await f.manager.backups(project.id), []);
  assert.equal(f.state.commits, 0);
});

test('an explicitly selected installed pack can preview a repaired build without inventing a before PDF', async (t) => {
  const f = await fixture(t);
  let targetReady = true;
  const manager = new CompilerMigration(path.join(f.root, 'pack-backups'), {
    ...f.deps,
    selectTarget: async (key) => {
      assert.equal(key, target.id);
      return target;
    },
    checkTarget: async () => {
      if (!targetReady) throw new Error('Previewed compiler unavailable');
    },
    compile: async (p) =>
      p.runtime?.id === old.id
        ? {
            projectId: p.id,
            revision: p.revision,
            status: 'error',
            diagnostics: [],
            durationMs: 1,
            log: 'Missing example.sty in the recorded compiler.',
          }
        : f.deps.compile(p),
  });
  const id = randomUUID();
  const comparison = await manager.prepare(id, project, target.id);
  assert.equal(comparison.baseline, 'build-error');
  assert.equal(comparison.before.length, 0);
  assert.match(comparison.beforeError!, /Missing example/);
  assert.deepEqual(Buffer.from(comparison.after), pdf('after'));
  assert.equal(f.state.commits, 0);
  const folder = path.dirname(await manager.backupPath(project.id, id));
  assert.equal(
    await fs.readFile(path.join(folder, 'before-error.txt'), 'utf8'),
    comparison.beforeError,
  );
  await assert.rejects(fs.stat(path.join(folder, 'before.pdf')), { code: 'ENOENT' });
  targetReady = false;
  await assert.rejects(manager.apply(id, project), /Previewed compiler unavailable/);
  assert.equal(f.state.commits, 0);
  targetReady = true;
  const applied = await manager.apply(id, project);
  assert.deepEqual(applied.project.runtime, target);
  const versions = (await f.workspace.load(project.id)).versions;
  assert.equal(versions.length, 1);
  assert.equal((await f.workspace.version(project.id, versions[0].id)).runtime?.id, target.id);
});

test('unverified selected targets and failed target builds cannot bypass comparison or change a project', async (t) => {
  const f = await fixture(t);
  const denied = new CompilerMigration(path.join(f.root, 'denied'), {
    ...f.deps,
    selectTarget: async () => {
      throw new Error('Pack not installed');
    },
  });
  await assert.rejects(denied.prepare(randomUUID(), project, 'untrusted'), /not installed/);
  assert.equal(denied.active, false);
  const failed = new CompilerMigration(path.join(f.root, 'failed-target'), {
    ...f.deps,
    selectTarget: async () => target,
  });
  f.state.failedBuild = true;
  await assert.rejects(
    failed.prepare(randomUUID(), project, target.id),
    /selected compiler could not build/,
  );
  assert.equal(f.state.commits, 0);
  assert.deepEqual(await failed.backups(project.id), []);
});

test('cancelling a running comparison waits for it and never commits a compiler choice', async (t) => {
  const f = await fixture(t);
  let release = () => {};
  let started = () => {};
  const began = new Promise<void>((resolve) => {
    started = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const manager = new CompilerMigration(path.join(f.root, 'backups'), {
    ...f.deps,
    compile: async (p) => {
      started();
      await gate;
      return f.deps.compile(p);
    },
    cancel: async () => release(),
  });
  const id = randomUUID(),
    preparing = manager.prepare(id, project);
  const rejected = assert.rejects(preparing, /cancelled/);
  await began;
  assert.throws(() => manager.prepare(randomUUID(), project), /Finish or cancel/);
  await manager.cancel(id);
  await rejected;
  assert.equal(manager.active, false);
  assert.equal(f.state.commits, 0);
});

test('a history error after recovery commits reports the change and keeps the complete backup', async (t) => {
  const f = await fixture(t),
    id = randomUUID();
  await f.manager.prepare(id, project);
  const checkpoint = f.workspace.checkpoint.bind(f.workspace);
  f.workspace.checkpoint = (p, bytes, label) =>
    p.runtime?.id === target.id
      ? Promise.reject(new Error('disk full'))
      : checkpoint(p, bytes, label);
  const result = await f.manager.apply(id, project);
  assert.match(result.warning!, /new history entry/);
  assert.deepEqual((await f.store.loadRecovery())?.runtime, target);
  assert.equal(f.manager.active, false);
  assert.equal((await f.manager.backups(project.id)).length, 1);
});

test('linked backup folders and changed asset snapshots during preparation are rejected', async (t) => {
  const f = await fixture(t),
    id = randomUUID();
  await f.manager.prepare(id, project);
  const folder = path.join(f.root, 'backups', project.id, id),
    moved = path.join(f.root, 'moved');
  await fs.rename(folder, moved);
  await fs.symlink(moved, folder);
  await assert.rejects(() => f.manager.apply(id, project), /linked folders/);
  assert.equal(f.state.commits, 0);
  await f.manager.cancel(id);
  let calls = 0;
  const changing = new CompilerMigration(path.join(f.root, 'other'), {
    ...f.deps,
    assets: async () => new Map([['portrait.png', Buffer.from(String(++calls))]]),
  });
  await assert.rejects(() => changing.prepare(randomUUID(), project), /assets changed during/);
});

test('forced exits at backup publication and recovery commit preserve a complete recoverable choice', async (t) => {
  for (const boundary of ['backed-up', 'committed']) {
    const f = await fixture(t);
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', 'tests/fixtures/migration-crash.ts', f.root, boundary],
      { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] },
    );
    await new Promise<void>((resolve, reject) => {
      let output = '',
        errors = '';
      const timeout = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error('Migration fixture timed out'));
      }, 15_000);
      child.stdout.on('data', (data) => {
        output += data;
        if (output.includes('READY-TO-KILL')) child.kill('SIGKILL');
      });
      child.stderr.on('data', (data) => {
        errors += data;
      });
      child.on('error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      child.on('exit', (_code, signal) => {
        clearTimeout(timeout);
        if (signal === 'SIGKILL' && output.includes('READY-TO-KILL')) resolve();
        else reject(new Error(errors || 'Unexpected fixture exit'));
      });
    });
    const recovered = await new ProjectStore(f.root).loadRecovery();
    assert.equal(recovered?.runtime?.id, (boundary === 'committed' ? 'b' : 'a').repeat(64));
    assert.equal(recovered?.files[0].content, 'Preserve my draft');
    const backups = await f.manager.backups('crash-resume');
    assert.equal(backups.length, 1);
    const archive = unzipSync(
      await fs.readFile(await f.manager.backupPath('crash-resume', backups[0].id)),
    );
    assert.equal(
      JSON.parse(Buffer.from(archive['resume.project.json']).toString()).runtime.id,
      'a'.repeat(64),
    );
    assert.equal(Buffer.from(archive['main.tex']).toString(), 'Preserve my draft');
  }
});

test('failure of the included compiler and full backup storage cannot change the project', async (t) => {
  const f = await fixture(t);
  const failing = new CompilerMigration(path.join(f.root, 'failed-backups'), {
    ...f.deps,
    compile: async (p) =>
      p.runtime?.id === target.id
        ? {
            projectId: p.id,
            revision: p.revision,
            status: 'error',
            diagnostics: [],
            log: 'Missing package in replacement',
            durationMs: 1,
          }
        : f.deps.compile(p),
  });
  await assert.rejects(
    () => failing.prepare(randomUUID(), project),
    /included compiler could not build/,
  );
  assert.equal(failing.active, false);
  assert.equal(f.state.commits, 0);
  await fs.mkdir(path.join(f.root, 'backups'));
  const filled = await fs.open(path.join(f.root, 'backups', 'existing-backup'), 'w');
  await filled.truncate(1024 * 1024 * 1024);
  await filled.close();
  await assert.rejects(() => f.manager.prepare(randomUUID(), project), /1 GB storage limit/);
  assert.equal(f.state.commits, 0);
  assert.equal(await f.store.loadRecovery(), null);
});
