import { _electron as electron, expect } from '@playwright/test';
import { promises as fs, createReadStream } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { tsImport } from 'tsx/esm/api';
import { buildProcessSampler, ProcessSampler } from './mac-process-sampler.mjs';
import { captureRendererRetention } from './capture-renderer-retention.mjs';
const { profileStorage } = await tsImport('./profile-directory-storage.ts', import.meta.url);

const [executableArg, seedArg, cycleArg = '10', diagnosticArg] = process.argv.slice(2);
const disposedEditor = diagnosticArg === '--retention-disposed-editor';
const retention = ['--retention', '--retention-paste', '--retention-disposed-editor'].includes(
  diagnosticArg,
);
const pasteInput = diagnosticArg === '--retention-paste';
const cycles = Number(cycleArg);
if (
  process.platform !== 'darwin' ||
  process.arch !== 'arm64' ||
  !executableArg ||
  !seedArg ||
  process.argv.length > 6 ||
  (diagnosticArg !== undefined && !retention) ||
  !Number.isInteger(cycles) ||
  cycles < 1 ||
  cycles > 20
)
  throw new Error(
    'Provide a packaged Folio executable, a completed synthetic process-profile directory and 1–20 cycles, optionally followed by --retention, --retention-paste or --retention-disposed-editor.',
  );
const executablePath = path.resolve(executableArg),
  seedRoot = path.resolve(seedArg);
const hash = async (file) => {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(file)) digest.update(chunk);
  return digest.digest('hex');
};
const seed = JSON.parse(await fs.readFile(path.join(seedRoot, 'measurements.json'), 'utf8'));
if (
  !seed.passed ||
  !seed.longSession ||
  seed.cycles !== 120 ||
  seed.errors.length ||
  seed.storage.at(-1)?.label !== 'closed'
)
  throw new Error('Use the completed 120-cycle synthetic fixture, never a personal app profile.');
const seedData = path.join(seedRoot, 'app-data');
const before = await profileStorage(seedData);
expect(before.entries).toEqual(seed.storage.at(-1).entries);
expect(before.symlinks).toBe(0);
const recovery = JSON.parse(await fs.readFile(path.join(seedData, 'recovery.json'), 'utf8'));
if (
  !recovery.project ||
  recovery.project.folder ||
  recovery.project.directory ||
  recovery.project.path ||
  recovery.project.name !== 'My resume'
)
  throw new Error('Expected an unsaved synthetic project.');
const manifest = async (directory, entries) => {
  const digest = createHash('sha256');
  for (const entry of entries) {
    digest.update(JSON.stringify(entry) + '\n');
    if (entry.kind === 'file') digest.update(await hash(path.join(directory, entry.path)));
  }
  return digest.digest('hex');
};
const seedHash = await manifest(seedData, before.entries);
await fs.mkdir('test-results', { recursive: true });
const root = await fs.mkdtemp(path.resolve('test-results/v8-profile-'));
const dataRoot = path.join(root, 'app-data');
await fs.cp(seedData, dataRoot, { recursive: true, force: false, errorOnExist: true });
const copied = await profileStorage(dataRoot);
expect(copied.entries).toEqual(before.entries);
expect(await manifest(dataRoot, copied.entries)).toBe(seedHash);
const asar = path.resolve(path.dirname(executablePath), '../Resources/app.asar');
const appAsarSha256 = await hash(asar);
// A changed application is allowed only in the explicit lifecycle experiment.
// Ordinary and paste-control runs retain the historical exact-app requirement.
if (disposedEditor) expect(appAsarSha256).not.toBe(seed.appAsarSha256);
else expect(appAsarSha256).toBe(seed.appAsarSha256);
const runtimeManifest = path.resolve(path.dirname(asar), 'runtime/manifest.json');
expect(await hash(runtimeManifest)).toBe(seed.runtimeManifestSha256);
const scripts = [
  'scripts/profile-v8-resources.mjs',
  'scripts/profile-directory-storage.ts',
  'scripts/mac-process-sampler.mjs',
  'scripts/sample-mac-processes.c',
];
if (retention) scripts.push('scripts/capture-renderer-retention.mjs');
const observer = await buildProcessSampler(root);
const report = {
  startedAt: new Date().toISOString(),
  sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  scripts: Object.fromEntries(await Promise.all(scripts.map(async (f) => [f, await hash(f)]))),
  appAsarSha256,
  applicationMode: disposedEditor ? 'changed app with disposed Chat editor' : 'unchanged seed app',
  runtimeManifestSha256: seed.runtimeManifestSha256,
  seed: {
    appAsarSha256: seed.appAsarSha256,
    runtimeManifestSha256: seed.runtimeManifestSha256,
    report: path.join(seedRoot, 'measurements.json'),
    reportSha256: await hash(path.join(seedRoot, 'measurements.json')),
    profileInventorySha256: seedHash,
    entries: before.entries.length,
    logicalFileBytes: before.logicalFileBytes,
    copiedExactly: true,
  },
  host: {
    platform: process.platform,
    arch: process.arch,
    os: os.release(),
    cpu: os.cpus()[0].model,
    logicalCpus: os.cpus().length,
    ramBytes: os.totalmem(),
    node: process.version,
  },
  instrumentation: {
    cpuSamplingIntervalMicroseconds: 1000,
    heapSamplingIntervalBytes: 65536,
    explicitGcRequested: false,
    postWorkloadRetentionDiagnostic: retention,
    nativeObserverSha256: await hash(observer),
  },
  scope:
    'Diagnostic CPU and sampled JavaScript allocation profiles on a copied synthetic history. Profiling changes CPU/allocation behavior; these timings are not acceptance or optimization comparisons. Heap samples estimate selected live allocations since sampling began, not all retained objects or native/PDF-worker/GPU memory. No heap snapshot or explicit GC is requested during the sampled workload. The optional retention diagnostic requests both after sampling stops and is reported separately. Original profile and app are preserved. The app starts new processes from copied on-disk history; it does not restore the preceding session heap. CPU profiles cover the selected V8 isolates rather than all native threads or subprocess CPU.',
  cycles,
  inputMethod: pasteInput ? 'synthetic CodeMirror paste event' : 'native keyboard.insertText',
  phases: [],
  pdfs: [],
  canvases: [],
  heapObservations: [],
  cpuProfiles: [],
  errors: [],
  passed: false,
};
console.log(`Diagnostic evidence: ${root}`);
let app, page, sampler, mainSession, rendererSession;
const env = { ...process.env, FOLIO_USER_DATA: dataRoot };
delete env.ELECTRON_RUN_AS_NODE;
delete env.FOLIO_TEST_RUNTIME_SEED;
const begin = async (name) => {
  const sample = await sampler.mark(name);
  report.phases.push({ name, atMs: sample.atMs, observedCpuSeconds: sample.observedCpuSeconds });
};
const mainPost = (method, params = {}) =>
  mainSession.evaluate(
    (session, { method, params }) =>
      new Promise((resolve, reject) =>
        session.post(method, params, (error, result) =>
          error ? reject(error) : resolve(result ?? {}),
        ),
      ),
    { method, params },
  );
const saveArtifact = async (name, value) => {
  const file = path.join(root, name);
  await fs.writeFile(file, JSON.stringify(value) + '\n');
  return { file, bytes: (await fs.stat(file)).size, sha256: await hash(file) };
};
const heap = async (label) => {
  const memory = await rendererSession.send('Runtime.getHeapUsage');
  const dom = await rendererSession.send('Memory.getDOMCounters');
  const mainMemory = await app.evaluate(() => process.memoryUsage());
  const profile = await rendererSession.send('HeapProfiler.getSamplingProfile');
  report.heapObservations.push({
    label,
    memory,
    dom,
    mainMemory,
    profile: await saveArtifact(`${label}-renderer.heapprofile`, profile.profile),
  });
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
  if (pasteInput)
    await editor.evaluate((node, text) => {
      const data = new DataTransfer();
      data.setData('text/plain', text);
      node.dispatchEvent(
        new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
      );
    }, text);
  else await page.keyboard.insertText(text);
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
  page = await app.firstWindow();
  page.setDefaultTimeout(60_000);
  page.on('pageerror', (error) => report.errors.push(error.message));
  page.on('console', (item) => {
    if (item.type() === 'error') report.errors.push(item.text());
  });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1480, 960));
  await page.getByRole('tab', { name: 'Code', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Compile', exact: true })).toBeEnabled({
    timeout: 180_000,
  });
  await page.getByLabel('Auto-compile', { exact: true }).uncheck();
  report.applicationVersions = await app.evaluate(() => ({
    node: process.versions.node,
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    v8: process.versions.v8,
  }));
  mainSession = await app.evaluateHandle(() => {
    const { Session } = process.getBuiltinModule('node:inspector');
    const session = new Session();
    session.connect();
    return session;
  });
  rendererSession = await page.context().newCDPSession(page);
  await mainPost('Profiler.enable');
  await mainPost('Profiler.setSamplingInterval', { interval: 1000 });
  await rendererSession.send('Profiler.enable');
  await rendererSession.send('Profiler.setSamplingInterval', { interval: 1000 });
  await rendererSession.send('HeapProfiler.enable');
  await rendererSession.send('HeapProfiler.startSampling', { samplingInterval: 65536 });
  sampler = new ProcessSampler(observer, app.process().pid, 200);
  await sampler.start();
  await begin('ready');
  await heap('ready');
  for (let cycle = 1; cycle <= cycles; cycle++) {
    await begin(`cycle-${cycle}`);
    await mainPost('Profiler.start');
    await rendererSession.send('Profiler.start');
    await compile(1, `Trace ${cycle} small`);
    await begin(`cycle-${cycle}-small-idle`);
    await new Promise((r) => setTimeout(r, 2500));
    await compile(100, `Trace ${cycle} long`);
    await begin(`cycle-${cycle}-navigation`);
    for (const number of [100, 50, 1]) {
      const sheet = page.locator(`.preview-pane .pdf-sheet[data-page="${number}"]`);
      await sheet.evaluate((node) => node.scrollIntoView({ block: 'start' }));
      await expect(sheet.locator('.textLayer')).toContainText(`Trace ${cycle} long page ${number}`);
      await canvas(`cycle-${cycle}-page-${number}`);
      await new Promise((r) => setTimeout(r, 500));
    }
    await begin(`cycle-${cycle}-long-idle`);
    await new Promise((r) => setTimeout(r, 2500));
    await compile(1, `Trace ${cycle} return`);
    await begin(`cycle-${cycle}-return-idle`);
    await new Promise((r) => setTimeout(r, 2500));
    await begin(`cycle-${cycle}-profile-read`);
    const main = await mainPost('Profiler.stop');
    const renderer = await rendererSession.send('Profiler.stop');
    expect(main.profile.samples.length).toBeGreaterThan(0);
    expect(renderer.profile.samples.length).toBeGreaterThan(0);
    report.cpuProfiles.push({
      cycle,
      main: await saveArtifact(`cycle-${cycle}-main.cpuprofile`, main.profile),
      renderer: await saveArtifact(`cycle-${cycle}-renderer.cpuprofile`, renderer.profile),
    });
    if (cycle === 1 || cycle % 5 === 0 || cycle === cycles) await heap(`cycle-${cycle}`);
    console.log(`Diagnostic cycle ${cycle}/${cycles} completed.`);
  }
  await begin('finished');
  await sampler.stop();
  await rendererSession.send('HeapProfiler.stopSampling');
  if (retention)
    report.retention = await captureRendererRetention({
      page,
      session: rendererSession,
      root,
      cycles,
      editorLifecycle: disposedEditor ? 'disposed' : 'mounted',
    });
  await rendererSession.send('Profiler.disable');
  await rendererSession.detach();
  rendererSession = undefined;
  await mainPost('Profiler.disable');
  await mainSession.evaluate((session) => session.disconnect());
  await mainSession.dispose();
  mainSession = undefined;
  await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
  await app.close().catch(() => {});
  app = undefined;
  const python = process.env.FOLIO_PYTHON ?? 'python3';
  for (const pdf of report.pdfs) {
    const actual = JSON.parse(
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
    expect(actual.pages).toBe(pdf.pages);
    expect(actual.first).toContain(`${pdf.label} page 1`);
    expect(actual.last).toContain(`${pdf.label} page ${pdf.pages}`);
    pdf.sha256 = await hash(pdf.path);
    pdf.bytes = (await fs.stat(pdf.path)).size;
    pdf.verified = true;
  }
  expect(report.errors).toEqual([]);
  expect(await hash(asar)).toBe(report.appAsarSha256);
  expect(await hash(runtimeManifest)).toBe(report.runtimeManifestSha256);
  const after = await profileStorage(seedData);
  expect(after.entries).toEqual(before.entries);
  expect(await manifest(seedData, after.entries)).toBe(seedHash);
  report.seed.preservedAfterRun = true;
  for (const file of scripts) expect(await hash(file)).toBe(report.scripts[file]);
  report.passed = true;
} catch (error) {
  report.errors.push(error.message);
  throw error;
} finally {
  await sampler?.stop().catch((error) => report.errors.push(error.message));
  await mainSession?.evaluate((session) => session.disconnect()).catch(() => {});
  await mainSession?.dispose().catch(() => {});
  await rendererSession?.detach().catch(() => {});
  await app?.evaluate(({ app }) => app.exit(0)).catch(() => {});
  await app?.close().catch(() => {});
  report.finishedAt = new Date().toISOString();
  report.samples = sampler?.samples ?? [];
  await fs.writeFile(path.join(root, 'measurements.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(`Evidence: ${root}`);
}
