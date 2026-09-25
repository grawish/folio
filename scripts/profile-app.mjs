import { _electron as electron, expect } from '@playwright/test';
import { promises as fs } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';
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
const report = {
  recordedAt: new Date().toISOString(),
  appAsarSha256: await hash(asar),
  scriptSha256: await hash('scripts/profile-app.mjs'),
  host: {
    platform: process.platform,
    arch: process.arch,
    os: os.release(),
    cpu: os.cpus()[0].model,
    logicalCpus: os.cpus().length,
    ramBytes: os.totalmem(),
    node: process.version,
  },
  limits: [
    'Fresh app profile and managed runtime per pair; operating-system disk/execution caches are not purged.',
    'Prepared launch uses the same profile after a normal window close.',
    'Electron app metrics exclude compiler/Biber subprocesses. Summed working sets may count shared pages more than once.',
    'End-to-end observations include automation overhead; these are not a reference-device p95 or an OS resource limit.',
  ],
  runs: [],
};
const write = () =>
  fs.writeFile(path.join(root, 'measurements.json'), JSON.stringify(report, null, 2) + '\n');
for (let i = 0; i < count; i++) {
  const data = path.join(root, `profile-${i + 1}`);
  for (const state of ['fresh', 'prepared']) {
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
      run.firstWindowMs = performance.now() - start;
      await expect(page.getByLabel('Message the resume agent')).toBeEnabled({ timeout: 120_000 });
      run.workspaceReadyMs = performance.now() - start;
      await page.getByText('Up to date', { exact: true }).waitFor({ timeout: 60_000 });
      await expect(page.locator('.preview-pane .textLayer')).toContainText('Alex Morgan', {
        timeout: 20_000,
      });
      run.firstPdfMs = performance.now() - start;
      await new Promise((resolve) => setTimeout(resolve, 2000));
      sampling = false;
      await sampler;
      run.peakSummedElectronWorkingSetKiB = Math.max(
        ...run.metrics.map((m) => m.processes.reduce((sum, p) => sum + p.workingSetKiB, 0)),
      );
      expect(run.errors).toEqual([]);
      const closed = page.waitForEvent('close');
      const closingAt = performance.now();
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
      await closed;
      run.windowCloseMs = performance.now() - closingAt;
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
