import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { Compiler } from '../../electron/core/compiler';
import { inspectRuntime, macSandboxProfile } from '../../electron/core/runtime';
import type { Project } from '../../src/shared/types';
import { templateCatalog, paperSizes, templateSource } from '../../src/shared/template-catalog';
import { buildHelp } from '../../src/shared/build-help';

const supported = process.platform === 'darwin';
const runtime = path.resolve(`resources/runtime/mac-${process.arch}`);
let root: string;
let compiler: Compiler;
function project(source: string, revision = 0): Project {
  return {
    id: 'integration',
    name: 'Test',
    revision,
    mainFile: 'main.tex',
    files: [{ path: 'main.tex', content: source }],
  };
}
const simple = '\\documentclass{article}\n\\begin{document}Offline resume\\end{document}';
before(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'folio-compile-')));
  compiler = new Compiler(runtime, path.join(root, 'work'));
});
after(async () => {
  await compiler.cancel();
  await fs.rm(root, { recursive: true, force: true });
});

test('runtime verifies compiler and bundle integrity', { skip: !supported }, async () => {
  const status = await inspectRuntime(runtime);
  assert.equal(status.ready, true, status.message);
});
test(
  'all shipped templates compile in the OS sandbox from a fresh offline cache',
  { skip: !supported },
  async () => {
    for (const template of templateCatalog) {
      const source = await fs.readFile(`resources/templates/${template.id}.tex`, 'utf8');
      for (const paper of paperSizes) {
        const isolated = new Compiler(runtime, path.join(root, `${template.id}-${paper.id}`));
        const result = await isolated.compile(project(templateSource(source, paper.id)));
        assert.equal(result.status, 'success', result.log);
        assert.ok(result.pdf && result.pdf.length > 5000);
        assert.doesNotMatch(result.log, /Overfull|Missing character|Font shape .*undefined/);
      }
    }
  },
);
test(
  'default article headings and font sizes compile offline from a fresh cache',
  { skip: !supported },
  async () => {
    const source = await fs.readFile('resources/runtime-checks/basic-headings.tex', 'utf8');
    const isolated = new Compiler(runtime, path.join(root, 'basic-headings'));
    const result = await isolated.compile(project(source));
    assert.equal(result.status, 'success', result.log);
    assert.ok(result.pdf && result.pdf.length > 5000);
  },
);
test(
  'imported resume packages and fonts compile with a fresh cache and network denied',
  { skip: !supported },
  async () => {
    const source = await fs.readFile('resources/runtime-checks/resume-packages.tex', 'utf8');
    const isolated = new Compiler(runtime, path.join(root, 'resume-packages'));
    try {
      const result = await isolated.compile(project(source));
      assert.equal(result.status, 'success', result.log);
      assert.ok(result.pdf && result.pdf.length > 5000);
    } finally {
      await isolated.cancel();
    }
  },
);
test(
  'syntax errors keep the prior PDF and do not permit exporting changed source',
  { skip: !supported },
  async () => {
    const valid = project(simple, 1);
    const success = await compiler.compile(valid);
    assert.equal(success.status, 'success', success.log);
    const bad = project(simple.replace('Offline resume', '\\undefinedcommand'), 2);
    const failure = await compiler.compile(bad);
    assert.equal(failure.status, 'error');
    assert.ok(failure.diagnostics.some((d) => d.severity === 'error'));
    assert.equal(compiler.currentPdf(bad), undefined);
    assert.deepEqual(compiler.currentPdf(valid), success.pdf);
    // Accepting changed assets advances the revision without changing TeX text.
    assert.equal(compiler.currentPdf({ ...valid, revision: valid.revision + 1 }), undefined);
  },
);
test(
  'missing dependencies and engine requirements have advice backed by successful local repairs',
  { skip: !supported },
  async () => {
    const cases = [
      {
        kind: 'package',
        source:
          '\\documentclass{article}\n\\usepackage{folio-sample}\n\\begin{document}Sample\\end{document}',
        file: { path: 'folio-sample.sty', content: '\\ProvidesPackage{folio-sample}\n' },
      },
      {
        kind: 'package',
        source: '\\documentclass{folio-sample}\n\\begin{document}Sample\\end{document}',
        file: {
          path: 'folio-sample.cls',
          content: '\\ProvidesClass{folio-sample}\n\\LoadClass{article}\n',
        },
      },
      {
        kind: 'file',
        source:
          '\\documentclass{article}\n\\begin{document}\\input{sections/example}\\end{document}',
        file: { path: 'sections/example.tex', content: 'Repaired local input.' },
      },
      {
        kind: 'font',
        source:
          '\\documentclass{article}\n\\usepackage{fontspec}\n\\setmainfont{Folio Missing Font}\n\\begin{document}Sample\\end{document}',
      },
      {
        kind: 'engine',
        source:
          '\\documentclass{article}\n\\usepackage{iftex}\\RequireLuaTeX\n\\begin{document}Sample\\end{document}',
      },
      {
        kind: 'engine',
        source:
          '\\documentclass{article}\n\\usepackage{iftex}\\RequirePDFTeX\n\\begin{document}Sample\\end{document}',
      },
    ];
    for (const entry of cases) {
      const broken = project(entry.source);
      const failed = await compiler.compile(broken);
      assert.equal(failed.status, 'error', failed.log);
      assert.equal(buildHelp(failed)?.kind, entry.kind, failed.log);
      const repaired = project(
        entry.source
          .replace('Folio Missing Font', 'lmroman10-regular.otf')
          .replace(/\\Require(?:Lua|PDF)TeX/, ''),
        1,
      );
      if (entry.file) repaired.files.push(entry.file);
      const success = await compiler.compile(repaired);
      assert.equal(success.status, 'success', success.log);
      assert.ok(success.pdf && success.pdf.length > 1000);
      assert.equal(buildHelp(success), undefined);
    }
  },
);
test(
  'multi-file unsaved snapshots compile with project-relative inputs',
  { skip: !supported },
  async () => {
    const p = project(simple.replace('Offline resume', '\\input{sections/experience}'));
    p.files.push({ path: 'sections/experience.tex', content: 'A role that has never been saved.' });
    const result = await compiler.compile(p);
    assert.equal(result.status, 'success', result.log);
  },
);
test(
  'new compilation cancels runaway work and publishes only the newest result',
  { skip: !supported },
  async () => {
    const pending = compiler.compile(
      project(simple.replace('Offline resume', '\\loop\\iftrue\\repeat'), 10),
    );
    await new Promise((resolve) => setTimeout(resolve, 300));
    const newest = compiler.compile(project(simple, 11));
    assert.equal((await pending).status, 'cancelled');
    const result = await newest;
    assert.equal(result.status, 'success', result.log);
    assert.equal(result.revision, 11);
  },
);
test('runaway compilation times out', { skip: !supported }, async () => {
  const limited = new Compiler(runtime, path.join(root, 'limited'), 1000);
  const result = await limited.compile(
    project(simple.replace('Offline resume', '\\loop\\iftrue\\repeat')),
  );
  assert.equal(result.status, 'error');
  assert.match(result.log, /time limit/);
});
test(
  'compiler cannot read or write outside its allowed directories',
  { skip: !supported },
  async () => {
    const outside = path.join(root, 'private.tex');
    await fs.writeFile(outside, 'OUTSIDE-SECRET');
    const read = await compiler.compile(
      project(simple.replace('Offline resume', `\\input{${outside}}`)),
    );
    assert.equal(read.status, 'error', read.log);
    const writeTarget = path.join(root, 'outside-output.tex');
    const write = await compiler.compile(
      project(
        simple.replace(
          'Offline resume',
          `\\newwrite\\out\\immediate\\openout\\out=${writeTarget}\\relax\\immediate\\write\\out{changed}`,
        ),
      ),
    );
    assert.equal(write.status, 'error', write.log);
    await assert.rejects(fs.access(writeTarget));
  },
);
test(
  'sandbox denies network connections and shell escape stays disabled',
  { skip: !supported },
  async () => {
    const profile = path.join(root, 'network.sb');
    const job = path.join(root, 'network-job');
    await fs.mkdir(job);
    // Apple's curl needs its public TLS configuration even for --version. This
    // fixture-only allowance does not change the compiler's production profile.
    await fs.writeFile(
      profile,
      macSandboxProfile('/usr/bin/curl', runtime, job, job) +
        '\n(allow file-read* (literal "/private/etc/ssl/openssl.cnf"))',
    );
    const curlEnv = { PATH: '/usr/bin:/bin', OPENSSL_CONF: '/dev/null' };
    const version = spawnSync(
      '/usr/bin/sandbox-exec',
      ['-f', profile, '/usr/bin/curl', '--disable', '--version'],
      { encoding: 'utf8', timeout: 5000, env: curlEnv },
    );
    assert.equal(version.status, 0, version.stderr);
    let requests = 0;
    const server = createServer((_req, res) => {
      requests++;
      res.end('test');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address() as { port: number };
      await fetch(`http://127.0.0.1:${address.port}`);
      assert.equal(requests, 1);
      requests = 0;
      const code = await new Promise<number | null>((resolve, reject) => {
        const child = spawn(
          '/usr/bin/sandbox-exec',
          [
            '-f',
            profile,
            '/usr/bin/curl',
            '--disable',
            '--connect-timeout',
            '2',
            `http://127.0.0.1:${address.port}`,
          ],
          { stdio: 'ignore', env: curlEnv },
        );
        child.on('close', resolve);
        child.on('error', reject);
      });
      assert.notEqual(code, 0);
      assert.equal(requests, 0);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    const shellTarget = path.join(root, 'shell-escape.txt');
    const result = await compiler.compile(
      project(
        simple.replace(
          'Offline resume',
          `\\immediate\\write18{touch ${shellTarget}}Disabled shell escape`,
        ),
      ),
    );
    assert.equal(result.status, 'success', result.log);
    await assert.rejects(fs.access(shellTarget));
  },
);
