// Runs the production Compiler (launch wrapper, environment, Biber cache and
// timers) against the prepared runtime for this OS. Used by the Windows/Linux
// release workflow, where the macOS native app suites do not apply.
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Compiler } from '../electron/core/compiler';
import type { Project } from '../src/shared/types';

const folder =
  process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'win' : 'linux';
const runtime = path.resolve('resources/runtime', `${folder}-${process.arch}`);
const work = await fs.mkdtemp(path.join(os.tmpdir(), 'folio-native-compile-'));
const compiler = new Compiler(runtime, work, 180_000);
const checks = [
  ['resources/runtime-checks/basic-headings.tex', 'headings'],
  ['resources/runtime-checks/resume-packages.tex', 'packages + Biber'],
  ['resources/templates/classic.tex', 'template'],
] as const;
const manifest = JSON.parse(await fs.readFile(path.join(runtime, 'manifest.json'), 'utf8'));
let failed = false;
try {
  for (const [file, label] of checks) {
    if (label.includes('Biber') && !manifest.biberVersion) {
      console.log(`skip ${label}: this runtime has no Biber`);
      continue;
    }
    try {
      await fs.access(file);
    } catch {
      console.log(`skip ${label}: ${file} not found`);
      continue;
    }
    const project: Project = {
      id: `native-${path.basename(file, '.tex')}`,
      name: label,
      revision: 1,
      mainFile: 'main.tex',
      files: [{ path: 'main.tex', content: await fs.readFile(file, 'utf8') }],
    };
    for (const attempt of ['cold', 'warm']) {
      const result = await compiler.compile({ ...project, revision: attempt === 'cold' ? 1 : 2 });
      const ok = result.status === 'success' && !!result.pdf && result.pdf.length > 1000;
      console.log(`${ok ? 'ok' : 'FAIL'} ${label} (${attempt}) ${result.durationMs} ms`);
      if (!ok) {
        failed = true;
        console.log(result.diagnostics.map((d) => d.message).join('\n'));
        console.log(result.log.slice(-4000));
      }
    }
  }
} finally {
  await compiler.cancel();
  await fs.rm(work, { recursive: true, force: true }).catch(() => {});
}
if (failed) process.exit(1);
