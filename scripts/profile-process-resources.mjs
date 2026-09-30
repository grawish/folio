import { _electron as electron, expect } from '@playwright/test';
import { promises as fs } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { buildProcessSampler, ProcessSampler } from './mac-process-sampler.mjs';
import { tsImport } from 'tsx/esm/api';
const { profileStorage } = await tsImport('./profile-directory-storage.ts', import.meta.url);

if (process.platform !== 'darwin' || process.arch !== 'arm64' || !process.argv[2])
  throw new Error('Provide a packaged Folio executable on an Apple silicon Mac.');
const executablePath = path.resolve(process.argv[2]);
const cycles = Number(process.argv[3] ?? 3);
const options = new Set(process.argv.slice(4));
const longSession = options.has('--long-session');
const extendedIdle = options.has('--extended-idle');
const maxCycles = longSession ? 120 : 5;
if (!Number.isInteger(cycles) || cycles < 1 || cycles > maxCycles)
  throw new Error(`Choose 1–${maxCycles} cycles${longSession ? '' : ', or use --long-session'}.`);
if ([...options].some((flag) => !['--long-session', '--extended-idle'].includes(flag)))
  throw new Error('Unknown profiling option.');
if (extendedIdle && !longSession) throw new Error('Use --extended-idle only with --long-session.');
const python = process.env.FOLIO_PYTHON ?? 'python3';
const pdfInspector = execFileSync(python, ['-c', 'import pypdf; print(pypdf.__version__)'], {
  encoding: 'utf8',
}).trim();
const hash = async (file) =>
  createHash('sha256')
    .update(await fs.readFile(file))
    .digest('hex');
await fs.mkdir('test-results', { recursive: true });
const root = await fs.mkdtemp(path.resolve('test-results/process-profile-'));
const observer = await buildProcessSampler(root);
const asar = path.resolve(path.dirname(executablePath), '../Resources/app.asar');
const files = [
  'scripts/profile-process-resources.mjs',
  'scripts/mac-process-sampler.mjs',
  'scripts/sample-mac-processes.c',
  'scripts/profile-directory-storage.ts',
];
const report = {
  startedAt: new Date().toISOString(),
  sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  appAsarSha256: await hash(asar),
  runtimeManifestSha256: await hash(path.resolve(path.dirname(asar), 'runtime/manifest.json')),
  scripts: Object.fromEntries(
    await Promise.all(files.map(async (file) => [file, await hash(file)])),
  ),
  host: {
    platform: process.platform,
    arch: process.arch,
    os: os.release(),
    cpu: os.cpus()[0].model,
    logicalCpus: os.cpus().length,
    ramBytes: os.totalmem(),
    node: process.version,
  },
  observer: {
    api: 'proc_listchildpids and proc_pid_rusage RUSAGE_INFO_V0',
    intervalMs: 200,
    sha256: await hash(observer),
    pdfInspector,
  },
  cycles,
  longSession,
  extendedIdle,
  storage: [],
  phases: [],
  pdfs: [],
  canvases: [],
  errors: [],
  passed: false,
  limits: [
    'Sampling starts after Electron automation attaches; earliest process startup can be missed. Runtime preparation uses a fresh app profile; OS caches are not purged.',
    'Root PID plus discovered descendants only. PDF workers are renderer threads, not separate sampled processes. Observed processes that exit retain their last CPU counters.',
    'Read-only libproc snapshots are not atomic; short-lived children and peaks between samples can be missed. Reparented helpers may leave the observed tree. PID plus birth time distinguishes reuse.',
    'Summed RSS and summed per-process physical footprint are accounting metrics, not unique physical memory. Shared pages and surfaces can be counted more than once.',
    'CPU is observed per-process user plus system time, scaled from Mach ticks with the reported timebase. Initial counters of processes born before sampling are excluded. Child CPU fields are not added. Missing terminal samples undercount CPU.',
    'The sampling helper and Playwright harness are outside the app tree but add host load. Their CPU cost and snapshot duration are reported separately; the desktop is not otherwise isolated.',
    'Repeated small-text 1/100-page workflows on one development Mac do not establish a leak, population percentiles, worst-case images/history, or supported-device memory/CPU budgets.',
    'Long-session storage observations read logical file sizes without following observed symlinks. Scans are non-atomic and run in separately marked phases outside builds/navigation; their host I/O and harness overhead can still affect the desktop. The closed final profile is inventoried after sampling. No deletion or GC is forced.',
    extendedIdle
      ? 'Extended-idle mode replaces each 2.5-second dwell with 10 seconds for diagnosis; its timing is not comparable to the standard workload.'
      : 'Standard idle dwell is 2.5 seconds.',
  ],
};
let app, page, sampler;
const env = { ...process.env, FOLIO_USER_DATA: path.join(root, 'app-data') };
delete env.ELECTRON_RUN_AS_NODE;
delete env.FOLIO_TEST_RUNTIME_SEED;
const harnessCpuStart = process.cpuUsage();
const begin = async (name) => {
  const sample = await sampler.mark(name);
  const previous = report.phases.at(-1);
  if (previous) {
    previous.endMs = sample.atMs;
    previous.observedCpuSeconds = sample.observedCpuSeconds - previous.cpuAtStart;
  }
  const phase = { name, startMs: sample.atMs, cpuAtStart: sample.observedCpuSeconds };
  report.phases.push(phase);
  return phase;
};
const idle = async (name) => {
  await begin(name);
  await new Promise((resolve) => setTimeout(resolve, extendedIdle ? 10_000 : 2500));
};
const storage = async (label, sampled = true) => {
  if (!longSession) return;
  if (sampled) await begin(`storage-${label}`);
  report.storage.push({ label, ...(await profileStorage(env.FOLIO_USER_DATA)) });
};
const source = (pages, label) =>
  String.raw`\documentclass[letterpaper]{article}
\usepackage{hyperref}
\begin{document}
` +
  Array.from(
    { length: pages },
    (_, i) => String.raw`\section*{${label} page ${i + 1}}
Synthetic text for process measurement. \href{https://example.com/folio}{Example link}.
`,
  ).join('\n\\newpage\n') +
  '\\end{document}';
const canvas = async (label) => {
  const value = await page.locator('.preview-pane').evaluate((node) => {
    const canvases = [...node.querySelectorAll('.pdf-sheet canvas')];
    return {
      pages: node.querySelectorAll('.pdf-sheet').length,
      renderedPages: node.querySelectorAll('.pdf-sheet > canvas').length,
      canvasPixels: canvases.reduce((sum, c) => sum + c.width * c.height, 0),
    };
  });
  expect(value.canvasPixels).toBeLessThanOrEqual(16 * 1024 * 1024);
  expect(value.renderedPages).toBeLessThanOrEqual(5);
  report.canvases.push({ label, ...value });
};
const compile = async (pages, label) => {
  await begin(`${label}-build`);
  const text = source(pages, label);
  const editor = page.locator('.cm-content');
  await editor.click();
  await editor.press('ControlOrMeta+A');
  await page.keyboard.insertText(text);
  await page.getByRole('button', { name: 'Compile', exact: true }).click();
  await expect(page.locator('.preview-pane .pdf-sheet')).toHaveCount(pages, { timeout: 60_000 });
  const first = page.locator('.preview-pane .pdf-sheet[data-page="1"]');
  await first.evaluate((node) => node.scrollIntoView({ block: 'start' }));
  await expect(first.locator('.textLayer')).toContainText(`${label} page 1`, { timeout: 60_000 });
  await page.getByText('Up to date', { exact: true }).waitFor({ timeout: 60_000 });
  await canvas(label);
  await begin(`${label}-export`);
  const filename = path.join(root, `${label}.pdf`);
  await app.evaluate(({ dialog }, filename) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: filename });
  }, filename);
  await page.getByRole('button', { name: 'Export PDF', exact: true }).click();
  await expect
    .poll(
      () =>
        fs
          .stat(filename)
          .then((s) => s.size)
          .catch(() => 0),
      { timeout: 60_000 },
    )
    .toBeGreaterThan(100);
  report.pdfs.push({
    path: filename,
    pages,
    label,
    sourceSha256: createHash('sha256').update(text).digest('hex'),
  });
};
try {
  app = await electron.launch({ executablePath, args: [], env, timeout: 120_000 });
  sampler = new ProcessSampler(observer, app.process().pid, 200);
  await sampler.start();
  report.phases.push({
    name: 'startup',
    startMs: sampler.samples[0].atMs,
    cpuAtStart: sampler.samples[0].observedCpuSeconds,
  });
  page = await app.firstWindow();
  page.setDefaultTimeout(60_000);
  page.on('pageerror', (error) => report.errors.push(error.message));
  page.on('console', (item) => {
    if (item.type() === 'error') report.errors.push(item.text());
  });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1480, 960));
  await page.getByText('Up to date', { exact: true }).waitFor({ timeout: 180_000 });
  report.viewport = await page.evaluate(() => ({
    width: innerWidth,
    height: innerHeight,
    devicePixelRatio,
  }));
  await idle('ready-idle');
  await storage('ready');
  await page.getByRole('tab', { name: 'Code', exact: true }).click();
  await page.getByLabel('Auto-compile', { exact: true }).uncheck();
  for (let cycle = 1; cycle <= cycles; cycle++) {
    await compile(1, `Cycle ${cycle} small`);
    await idle(`cycle-${cycle}-small-idle`);
    await compile(100, `Cycle ${cycle} long`);
    await begin(`cycle-${cycle}-navigation`);
    for (const number of [100, 50, 1]) {
      const sheet = page.locator(`.preview-pane .pdf-sheet[data-page="${number}"]`);
      await sheet.evaluate((node) => node.scrollIntoView({ block: 'start' }));
      await expect(sheet.locator('.textLayer')).toContainText(`Cycle ${cycle} long page ${number}`);
      await canvas(`cycle-${cycle}-page-${number}`);
      // Allow samples while each destination stays visible. This dwell is part
      // of the workload, not a measurement of navigation latency.
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    await idle(`cycle-${cycle}-long-idle`);
    await compile(1, `Cycle ${cycle} return`);
    await idle(`cycle-${cycle}-return-idle`);
    if (cycle % 10 === 0 || cycle === cycles) await storage(`cycle-${cycle}`);
    console.log(
      `Measured cycle ${cycle}/${cycles}: one page, 100 pages, navigation, one page again.`,
    );
  }
  await begin('finished');
  report.phases.pop();
  await sampler.stop();
  const usage = process.cpuUsage(harnessCpuStart);
  report.harnessCpuSeconds = (usage.user + usage.system) / 1e6;
  await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
  await app.close().catch(() => {});
  app = undefined;
  await storage('closed', false);
  // Inspect PDFs after sampling so the inspector cannot contend with measured builds.
  for (const pdf of report.pdfs) {
    const result = JSON.parse(
      execFileSync(
        python,
        [
          '-c',
          'import json,sys;from pypdf import PdfReader;r=PdfReader(sys.argv[1]);print(json.dumps({"pages":len(r.pages),"first":r.pages[0].extract_text(),"last":r.pages[-1].extract_text()}))',
          pdf.path,
        ],
        { encoding: 'utf8' },
      ),
    );
    expect(result.pages).toBe(pdf.pages);
    expect(result.first).toContain(`${pdf.label} page 1`);
    expect(result.last).toContain(`${pdf.label} page ${pdf.pages}`);
    pdf.sha256 = await hash(pdf.path);
    pdf.bytes = (await fs.stat(pdf.path)).size;
    pdf.verified = true;
  }
  expect(report.errors).toEqual([]);
  expect(await hash(asar)).toBe(report.appAsarSha256);
  expect(await hash(path.resolve(path.dirname(asar), 'runtime/manifest.json'))).toBe(
    report.runtimeManifestSha256,
  );
  for (const file of files) expect(await hash(file)).toBe(report.scripts[file]);
  report.passed = true;
} finally {
  await sampler?.stop().catch((error) => report.errors.push(error.message));
  await app?.evaluate(({ app }) => app.exit(0)).catch(() => {});
  await app?.close().catch(() => {});
  report.finishedAt = new Date().toISOString();
  report.samples = sampler?.samples ?? [];
  for (const phase of report.phases) {
    const rows = report.samples.filter((row) => row.phase === phase.name);
    phase.samples = rows.length;
    phase.peakSummedRssBytes = Math.max(0, ...rows.map((row) => row.summedRssBytes));
    phase.peakSummedFootprintBytes = Math.max(0, ...rows.map((row) => row.summedFootprintBytes));
  }
  report.observer.samples = report.samples.length;
  report.observer.totalCpuSeconds = report.samples.reduce(
    (sum, row) => sum + row.samplerCpuSeconds,
    0,
  );
  report.observer.maxCollectionMs = Math.max(0, ...report.samples.map((row) => row.collectionMs));
  report.observer.maxSampleGapMs = Math.max(
    0,
    ...report.samples.slice(1).map((row, i) => row.atMs - report.samples[i].atMs),
  );
  report.observer.vanishedDuringReads = report.samples.reduce((sum, row) => sum + row.vanished, 0);
  await fs.writeFile(path.join(root, 'measurements.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(`Evidence: ${root}`);
}
