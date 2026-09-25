import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { RuntimeManager } from '../../electron/core/runtime-manager';
import { Compiler } from '../../electron/core/compiler';
import type { Project } from '../../src/shared/types';

test(
  'managed real runtime builds offline, refuses corruption and repairs without changing its pin',
  { skip: process.platform !== 'darwin', timeout: 180_000 },
  async (t) => {
    const root = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), 'folio-managed-native-')),
    );
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const managed = path.join(root, 'Résumé compiler copies');
    const manager = new RuntimeManager(
      path.resolve(`resources/runtime/mac-${process.arch}`),
      managed,
    );
    const started = performance.now();
    await manager.initialize();
    const preparedMs = Math.round(performance.now() - started);
    const status = await manager.status();
    assert.equal(status.ready, true, status.message);
    const pin = status.pin!;
    const compiler = new Compiler(manager, path.join(root, 'Builds with spaces'));
    t.after(() => compiler.cancel());
    const fixture = await fs.readFile('resources/runtime-checks/resume-packages.tex', 'utf8');
    // Keep the same complete font/package corpus, but supply its bibliography as
    // a project file. An embedded filecontents output is reported as changed on
    // each Tectonic pass, needlessly consuming the six-pass maximum in this test.
    // The original embedded-file fixture remains covered by compiler.test.ts.
    const bibliography =
      /\\begin\{filecontents\*\}\{resume-check\.bib\}\n([\s\S]*?)\\end\{filecontents\*\}/;
    const entries = fixture.match(bibliography)?.[1];
    assert.ok(entries, 'The compatibility fixture must include its bibliography.');
    const project: Project = {
      id: 'managed-native',
      name: 'Managed runtime',
      mainFile: 'main.tex',
      revision: 0,
      runtime: pin,
      files: [
        {
          path: 'main.tex',
          content: fixture.replace(bibliography, ''),
        },
        { path: 'resume-check.bib', content: entries },
      ],
    };
    const before = await compiler.compile(project);
    assert.equal(before.status, 'success', before.log);
    assert.match(before.log, /Running external tool biber/);
    assert.ok(before.pdf && before.pdf.length > 5000);
    assert.equal(
      compiler.currentPdf({ ...project, runtime: { ...pin, id: 'a'.repeat(64) } }),
      undefined,
    );
    const pointerPath = path.join(managed, pin.id!, 'active.json');
    const first = JSON.parse(await fs.readFile(pointerPath, 'utf8'));
    await fs.writeFile(
      path.join(managed, pin.id!, 'copies', first.generation, 'runtime', 'bundle.zip'),
      'Damaged resources',
    );
    const changed = { ...project, revision: 1 };
    const damaged = await compiler.compile(changed);
    assert.equal(damaged.status, 'error');
    assert.equal(damaged.runtimeUnavailable, true);
    assert.match(damaged.log, /integrity check/);
    assert.equal(compiler.currentPdf(changed), undefined);
    const repairStarted = performance.now();
    const repaired = await manager.repair(pin);
    assert.equal(repaired.ready, true, repaired.message);
    assert.deepEqual(repaired.pin, pin);
    const second = JSON.parse(await fs.readFile(pointerPath, 'utf8'));
    assert.notEqual(first.generation, second.generation);
    const rebuilt = await compiler.compile(changed);
    assert.equal(rebuilt.status, 'success', rebuilt.log);
    assert.match(rebuilt.log, /Running external tool biber/);
    assert.ok(rebuilt.pdf && rebuilt.pdf.length > 5000);
    t.diagnostic(
      `Verified real offline setup ${preparedMs} ms; repair plus restored Biber build ${Math.round(performance.now() - repairStarted)} ms. These are development-host observations, not release benchmarks.`,
    );
  },
);
