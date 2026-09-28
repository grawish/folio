import { _electron as electron, expect } from '@playwright/test';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

if (process.platform !== 'darwin' || process.arch !== 'arm64' || !process.argv[2])
  throw new Error('Provide a packaged Folio executable on an Apple silicon Mac.');
const exec = promisify(execFile);
const executablePath = path.resolve(process.argv[2]);
const resources = path.resolve(path.dirname(executablePath), '../Resources');
const hash = async (file) =>
  createHash('sha256')
    .update(await fs.readFile(file))
    .digest('hex');
const root = await fs.mkdtemp(path.resolve('test-results/build-requests-'));
const folder = path.join(root, 'project');
await fs.mkdir(folder);
const source = String.raw`\documentclass{article}\begin{document}Queue fixture.\end{document}`;
await fs.writeFile(path.join(folder, 'main.tex'), source);
const report = {
  sourceCommit: (await exec('git', ['rev-parse', 'HEAD'])).stdout.trim(),
  scriptSha256: await hash('scripts/test-build-requests.mjs'),
  sourceHashes: Object.fromEntries(
    await Promise.all(
      [
        'electron/main.ts',
        'electron/core/compiler.ts',
        'electron/core/build-requests.ts',
        'electron/core/latest-work-queue.ts',
        'electron/preload.ts',
      ].map(async (file) => [file, await hash(file)]),
    ),
  ),
  appAsarSha256: await hash(path.join(resources, 'app.asar')),
  runtimeManifestSha256: await hash(path.join(resources, 'runtime/manifest.json')),
  scope:
    'Isolated packaged app, real preload/IPC/disk review/compiler/history; one synthetic project-directory lstat is held to expose queued requests. No AI call or user profile.',
  checks: [],
  errors: [],
  passed: false,
};
const env = { ...process.env, FOLIO_USER_DATA: path.join(root, 'data') };
delete env.ELECTRON_RUN_AS_NODE;
delete env.FOLIO_TEST_RUNTIME_SEED;
let app, page;
const holdReview = () =>
  app.evaluate(async (_, folder) => {
    const fs = process.getBuiltinModule('node:fs').promises;
    const original = fs.lstat;
    let release;
    const hold = new Promise((resolve) => {
      release = resolve;
    });
    const state = {
      entered: false,
      calls: 0,
      release,
      restore: () => {
        fs.lstat = original;
      },
    };
    fs.lstat = async function (filename, ...args) {
      if (filename === folder) {
        state.calls++;
        if (!state.entered) {
          state.entered = true;
          await hold;
        }
      }
      return original.call(this, filename, ...args);
    };
    globalThis.folioBuildHold = state;
  }, folder);
const releaseReview = () =>
  app.evaluate(() => {
    globalThis.folioBuildHold.release();
    globalThis.folioBuildHold.restore();
  });
const start = (project, revision) =>
  page.evaluate(
    ({ project, revision }) => {
      window.folioBuildResults = [];
      window.folioBuildPromises = [];
      window.folioBuildProject = project;
      window.folioEnqueueBuild = (revision) => {
        const next = {
          ...project,
          revision,
          files: [
            {
              path: 'main.tex',
              content: `\\documentclass{article}\\begin{document}Newest queued resume ${revision}.\\end{document}`,
            },
          ],
        };
        const promise = window.folio.compile(next).then((result) => {
          window.folioBuildResults.push({ revision: result.revision, status: result.status });
          return result;
        });
        window.folioBuildPromises.push(promise);
      };
      window.folioEnqueueBuild(revision);
    },
    { project, revision },
  );
try {
  app = await electron.launch({ executablePath, args: [], env, timeout: 60_000 });
  page = await app.firstWindow();
  page.setDefaultTimeout(15_000);
  page.on('pageerror', (error) => report.errors.push(error.message));
  await expect(page.getByLabel('Message the resume agent')).toBeEnabled({ timeout: 120_000 });
  await expect(page.locator('.compiler-preparation')).toHaveCount(0, { timeout: 120_000 });
  await page.getByRole('tab', { name: 'Code', exact: true }).click();
  await page.getByRole('checkbox', { name: 'Auto-compile', exact: true }).uncheck();
  await page.evaluate(() => window.folio.cancelBuild());
  await app.evaluate(({ dialog }, folder) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] });
  }, folder);
  const project = await page.evaluate(() => window.folio.openFolder());

  await holdReview();
  await start(project, 0);
  await expect.poll(() => app.evaluate(() => globalThis.folioBuildHold.entered)).toBe(true);
  await page.evaluate(() => {
    for (let i = 1; i <= 500; i++) window.folioEnqueueBuild(i);
  });
  await expect.poll(() => page.evaluate(() => window.folioBuildResults.length)).toBe(499);
  report.whileHeld = await page.evaluate(() => ({
    requests: window.folioBuildPromises.length,
    settled: window.folioBuildResults.length,
    cancelled: window.folioBuildResults.filter((r) => r.status === 'cancelled').length,
  }));
  expect(report.whileHeld).toEqual({ requests: 501, settled: 499, cancelled: 499 });
  expect(await app.evaluate(() => globalThis.folioBuildHold.calls)).toBe(1);
  await releaseReview();
  const results = await page.evaluate(async () => {
    const results = await Promise.all(window.folioBuildPromises);
    return results.map((r) => ({ ...r, pdf: r.pdf ? Array.from(r.pdf) : undefined }));
  });
  expect(results.slice(0, -1).every((r) => r.status === 'cancelled' && !r.pdf)).toBe(true);
  expect(results.slice(0, -1).map((r) => r.revision)).toEqual(
    Array.from({ length: 500 }, (_, i) => i),
  );
  const newest = results.at(-1);
  expect(newest.status, newest.log).toBe('success');
  expect(newest.revision).toBe(500);
  expect(newest.versionId).toBeTruthy();
  await fs.writeFile(path.join(root, 'newest.pdf'), Buffer.from(newest.pdf));
  const history = await page.evaluate((id) => window.folio.loadWorkspace(id), project.id);
  expect(history.versions).toHaveLength(1);
  expect(history.versions[0].id).toBe(newest.versionId);
  report.checks.push(
    '499 superseded IPC requests settle while disk review remains held; only revision 500 produces a PDF and history entry.',
  );

  await holdReview();
  await start(project, 501);
  await expect.poll(() => app.evaluate(() => globalThis.folioBuildHold.entered)).toBe(true);
  const guards = await page.evaluate(
    async ({ id, version }) => {
      const messages = [];
      for (const request of [
        () => window.folio.removeHistoryVersion(id, version),
        () => window.folio.removeStoredCompiler('synthetic-unused-key', 'synthetic-unused-token'),
      ]) {
        try {
          await request();
          messages.push('unexpected success');
        } catch (error) {
          messages.push(error.message);
        }
      }
      window.folioEnqueueBuild(502);
      window.folioStopFinished = false;
      window.folioStopPromise = window.folio.cancelBuild().then(() => {
        window.folioStopFinished = true;
      });
      return messages;
    },
    { id: project.id, version: newest.versionId },
  );
  expect(guards[0]).toContain('Finish building');
  expect(guards[1]).toContain('Finish the AI request and PDF build');
  await expect.poll(() => page.evaluate(() => window.folioBuildResults.length)).toBe(1);
  expect(await page.evaluate(() => window.folioStopFinished)).toBe(false);
  await releaseReview();
  const stopped = await page.evaluate(async () => {
    await window.folioStopPromise;
    return (await Promise.all(window.folioBuildPromises)).map((r) => ({
      revision: r.revision,
      status: r.status,
    }));
  });
  expect(stopped).toEqual([
    { revision: 501, status: 'cancelled' },
    { revision: 502, status: 'cancelled' },
  ]);
  expect(
    (await page.evaluate((id) => window.folio.loadWorkspace(id), project.id)).versions,
  ).toHaveLength(1);
  report.checks.push(
    'Stop drops pending IPC work and waits for active disk review; history and runtime removal remain blocked while review is held.',
  );
  const parsed = JSON.parse(
    (
      await exec(process.env.FOLIO_PYTHON ?? 'python3', [
        '-c',
        'import pypdf,json,sys; d=pypdf.PdfReader(sys.argv[1]); print(json.dumps({"pages":len(d.pages),"text":"".join(p.extract_text() for p in d.pages)}))',
        path.join(root, 'newest.pdf'),
      ])
    ).stdout,
  );
  expect(parsed.pages).toBe(1);
  expect(parsed.text).toContain('Newest queued resume 500.');
  report.pdf = {
    ...parsed,
    sha256: await hash(path.join(root, 'newest.pdf')),
    versionId: newest.versionId,
  };
  report.checks.push(
    'The final real PDF is independently parsed and contains the newest requested text.',
  );
  expect(report.errors).toEqual([]);
  report.passed = true;
  console.log(
    'PASS: bounded editor builds, pending cancellation, disk-cleanup wait, removal guards and newest native PDF.',
  );
} catch (error) {
  report.failure = { message: error.message, stack: error.stack };
  await page?.screenshot({ path: path.join(root, 'failure.png') }).catch(() => {});
  throw error;
} finally {
  await app
    ?.evaluate(() => {
      globalThis.folioBuildHold?.release();
      globalThis.folioBuildHold?.restore();
    })
    .catch(() => {});
  await fs.writeFile(path.join(root, 'result.json'), JSON.stringify(report, null, 2) + '\n');
  if (app) {
    await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
    await app.close().catch(() => {});
  }
  console.log(`Evidence: ${root}`);
}
