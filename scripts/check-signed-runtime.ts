import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { Compiler } from '../electron/core/compiler';
import { verifyRuntime } from '../electron/core/runtime';

/** Exercise the actual signed helpers under the application's unchanged sandbox.
 * A valid codesign result alone does not show that PAR or a dylib still works. */
export async function checkSignedRuntime(runtime: string) {
  const { pin } = await verifyRuntime(runtime);
  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'folio-signed-check-'));
  const compiler = new Compiler(runtime, work, 60_000);
  try {
    const content = pin.biberVersion
      ? await fs.readFile(
          fileURLToPath(
            new URL('../resources/runtime-checks/resume-packages.tex', import.meta.url),
          ),
          'utf8',
        )
      : '\\documentclass{article}\\begin{document}Folio signed compiler check.\\end{document}';
    const result = await compiler.compile({
      id: 'signed-runtime-check',
      name: 'Signed runtime check',
      revision: 0,
      mainFile: 'main.tex',
      runtime: pin,
      files: [{ path: 'main.tex', content }],
    });
    if (
      result.status !== 'success' ||
      !result.pdf ||
      (pin.biberVersion && !result.log.includes('Running external tool biber'))
    )
      throw new Error(`The signed compiler failed its offline check: ${result.log.slice(-4000)}`);
    await verifyRuntime(runtime, pin);
    return {
      passed: true,
      pin,
      pdfBytes: result.pdf.length,
      pdfSha256: createHash('sha256').update(result.pdf).digest('hex'),
      logSha256: createHash('sha256').update(result.log).digest('hex'),
      durationMs: result.durationMs,
      scope: 'App-owned resume/font/bibliography fixture in the normal offline macOS sandbox.',
    };
  } finally {
    await compiler.cancel();
    await fs.rm(work, { recursive: true, force: true });
  }
}
