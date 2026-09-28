import { _electron as electron, expect } from '@playwright/test';
import { promises as fs } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';

if (process.platform !== 'darwin' || process.arch !== 'arm64')
  throw new Error('Run on an Apple silicon Mac.');
const executablePath = path.resolve(
  process.argv[2] ?? 'release/import-recovery/mac-arm64/Folio.app/Contents/MacOS/Folio',
);
const count = Number(process.argv[3] ?? 3);
if (!Number.isInteger(count) || count < 1 || count > 10) throw new Error('Choose 1–10 samples.');
await fs.mkdir('test-results', { recursive: true });
const root = await fs.mkdtemp(path.resolve('test-results/app-profile-'));
const asar = path.resolve(path.dirname(executablePath), '../Resources/app.asar');
const hash = async (file) =>
  createHash('sha256')
    .update(await fs.readFile(file))
    .digest('hex');
const templateSource = await fs.readFile('resources/templates/classic.tex', 'utf8');
const report = {
  schemaVersion: 2,
  sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  runtimeManifestSha256: await hash(path.resolve(path.dirname(asar), 'runtime/manifest.json')),
  templateSourceSha256: await hash('resources/templates/classic.tex'),
  recordedAt: new Date().toISOString(),
  appAsarSha256: await hash(asar),
  scriptSha256: await hash('scripts/profile-app.mjs'),
  host: {
    platform: process.platform,
    arch: process.arch,
    os: os.release(),
    macos: execFileSync('sw_vers', ['-productVersion'], { encoding: 'utf8' }).trim(),
    cpu: os.cpus()[0].model,
    logicalCpus: os.cpus().length,
    ramBytes: os.totalmem(),
    node: process.version,
  },
  limits: [
    'Fresh app profile and managed runtime per pair; operating-system disk/execution caches are not purged.',
    'Prepared launch uses the same profile after a normal window close. Its recovered source and chat draft must match the fresh launch.',
    'Each launch verifies a short synthetic chat draft. Draft writing and sampling are part of this workload; no AI request is sent.',
    'Paint entries are Chromium first-paint/contentful-paint relative to renderer navigation. They are not launch-relative, complete-workspace paint or physical-display timestamps.',
    'Electron app metrics exclude compiler/Biber subprocesses. Summed working sets may count shared pages more than once.',
    'End-to-end observations include automation overhead; these are not a reference-device p95 or an OS resource limit.',
  ],
  runs: [],
};
const write = () =>
  fs.writeFile(path.join(root, 'measurements.json'), JSON.stringify(report, null, 2) + '\n');
for (let i = 0; i < count; i++) {
  const data = path.join(root, `profile-${i + 1}`);
  let recoveredId;
  const draft = `Synthetic startup draft for pair ${i + 1}`;
  for (const state of ['fresh', 'prepared']) {
    const recovery = path.join(data, 'recovery.json');
    if (state === 'fresh') await expect(fs.access(data)).rejects.toThrow();
    else expect(JSON.parse(await fs.readFile(recovery, 'utf8')).project.id).toBe(recoveredId);
    const start = performance.now();
    const run = { sample: i + 1, state, metrics: [], errors: [], passed: false };
    report.runs.push(run);
    const env = { ...process.env, FOLIO_USER_DATA: data };
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.FOLIO_TEST_RUNTIME_SEED;
    let app,
      sampling = false,
      sampler;
    try {
      app = await electron.launch({ executablePath, args: [], env, timeout: 120_000 });
      run.launchConnectedMs = performance.now() - start;
      sampling = true;
      sampler = (async () => {
        while (sampling) {
          const metrics = await app.evaluate(({ app }) =>
            app.getAppMetrics().map((m) => ({
              type: m.type,
              cpuPercent: m.cpu.percentCPUUsage,
              workingSetKiB: m.memory.workingSetSize,
              peakWorkingSetKiB: m.memory.peakWorkingSetSize,
            })),
          );
          run.metrics.push({ elapsedMs: performance.now() - start, processes: metrics });
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
      })().catch((error) => {
        if (sampling) run.errors.push(error.message);
      });
      const page = await app.firstWindow({ timeout: 120_000 });
      page.on('pageerror', (error) => run.errors.push(error.message));
      page.on('console', (item) => {
        if (item.type() === 'error') run.errors.push(item.text());
      });
      run.firstWindowMs = performance.now() - start;
      await expect(page.getByLabel('Message the resume agent')).toBeEnabled({ timeout: 120_000 });
      run.workspaceReadyMs = performance.now() - start;
      expect(await page.locator('.app-shell').getAttribute('inert')).toBeNull();
      run.compilerPreparingWhenWorkspaceReady = await page
        .locator('.compiler-preparation')
        .isVisible();
      const composer = page.getByLabel('Message the resume agent');
      await expect(composer).toHaveValue(state === 'fresh' ? '' : `${draft} fresh`);
      const inputStart = performance.now();
      await composer.fill(`${draft} ${state}`);
      await expect(composer).toHaveValue(`${draft} ${state}`);
      run.chatInputVerifiedMs = performance.now() - start;
      run.chatInputObservationMs = performance.now() - inputStart;
      await page.getByText('Up to date', { exact: true }).waitFor({ timeout: 60_000 });
      await expect(page.locator('.preview-pane .textLayer')).toContainText('Alex Morgan', {
        timeout: 20_000,
      });
      run.firstPdfMs = performance.now() - start;
      run.rendererPaint = await page.evaluate(() =>
        performance.getEntriesByType('paint').map((entry) => ({
          name: entry.name,
          navigationRelativeMs: entry.startTime,
        })),
      );
      for (const name of ['first-paint', 'first-contentful-paint']) {
        const entry = run.rendererPaint.find((entry) => entry.name === name);
        expect(entry?.navigationRelativeMs).toBeGreaterThanOrEqual(0);
      }
      await expect(composer).toHaveValue(`${draft} ${state}`);
      await new Promise((resolve) => setTimeout(resolve, 2000));
      sampling = false;
      await sampler;
      run.peakSummedElectronWorkingSetKiB = Math.max(
        ...run.metrics.map((m) => m.processes.reduce((sum, p) => sum + p.workingSetKiB, 0)),
      );
      expect(run.errors).toEqual([]);
      if (i === 0) await page.screenshot({ path: path.join(root, `${state}-ready.png`) });
      const closed = page.waitForEvent('close');
      const closingAt = performance.now();
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
      await closed;
      run.windowCloseMs = performance.now() - closingAt;
      const recovered = JSON.parse(await fs.readFile(recovery, 'utf8')).project;
      expect(recovered.mainFile).toBe('main.tex');
      expect(recovered.files).toEqual([{ path: 'main.tex', content: templateSource }]);
      if (state === 'fresh') recoveredId = recovered.id;
      else expect(recovered.id).toBe(recoveredId);
      run.recovery = {
        sha256: await hash(recovery),
        projectId: recovered.id,
        exactTemplateSource: true,
        runtime: recovered.runtime,
      };
      expect(recovered.runtime?.id).toMatch(/^[a-f0-9]{64}$/);
      run.passed = true;
      console.log(
        `Sample ${i + 1} ${state}: workspace ${run.workspaceReadyMs.toFixed(0)} ms, PDF ${run.firstPdfMs.toFixed(0)} ms, Electron working-set peak ${(run.peakSummedElectronWorkingSetKiB / 1024).toFixed(1)} MiB`,
      );
    } catch (error) {
      run.errors.push(error.message);
      throw error;
    } finally {
      sampling = false;
      await sampler;
      await app?.evaluate(({ app }) => app.exit(0)).catch(() => {});
      await app?.close().catch(() => {});
      await write();
    }
  }
}
if ((await hash(asar)) !== report.appAsarSha256) throw new Error('App changed during measurement.');
report.completedAt = new Date().toISOString();
await write();
console.log(`Evidence: ${root}`);
