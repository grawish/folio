import { _electron as electron, expect } from '@playwright/test';
import { promises as fs } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { buildProcessSampler, ProcessSampler } from './mac-process-sampler.mjs';

const [executableArg, mode, countArg = '120'] = process.argv.slice(2);
const cycles = Number(countArg);
if (
  process.platform !== 'darwin' ||
  process.arch !== 'arm64' ||
  !executableArg ||
  !['code', 'chat'].includes(mode) ||
  !Number.isInteger(cycles) ||
  cycles < 1 ||
  cycles > 120 ||
  process.argv.length > 5
)
  throw new Error('Provide an Apple silicon Folio executable, code or chat, and 1–120 cycles.');
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const fileHash = async (file) => hash(await fs.readFile(file));
const executablePath = path.resolve(executableArg);
const asar = path.resolve(path.dirname(executablePath), '../Resources/app.asar');
const runtimeManifest = path.resolve(path.dirname(asar), 'runtime/manifest.json');
await fs.mkdir('test-results', { recursive: true });
const root = await fs.mkdtemp(path.resolve('test-results/editor-session-'));
const dataRoot = path.join(root, 'app-data');
const folder = path.join(root, 'project');
await fs.mkdir(folder);
const base = String.raw`\documentclass{article}
\begin{document}
\section*{Typing session}
Ordinary edit number 0000.
\end{document}
% Notes`;
await fs.writeFile(path.join(folder, 'main.tex'), base);
const harness = await fs.readFile(fileURLToPath(import.meta.url));
await fs.writeFile(path.join(root, 'harness.mjs'), harness);
const observer = await buildProcessSampler(root);
const scripts = [
  'scripts/profile-editor-session.mjs',
  'scripts/mac-process-sampler.mjs',
  'scripts/sample-mac-processes.c',
];
const report = {
  startedAt: new Date().toISOString(),
  sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  scripts: Object.fromEntries(await Promise.all(scripts.map(async (f) => [f, await fileHash(f)]))),
  appAsarSha256: await fileHash(asar),
  runtimeManifestSha256: await fileHash(runtimeManifest),
  host: {
    platform: process.platform,
    arch: process.arch,
    os: os.release(),
    cpu: os.cpus()[0].model,
    logicalCpus: os.cpus().length,
    ramBytes: os.totalmem(),
    node: process.version,
  },
  mode,
  cycles,
  inputMethod: 'ordinary keyboard events for four revision digits and one short comment per cycle',
  instrumentation: {
    explicitGcRequested: false,
    heapSnapshotsRequested: false,
    allocationSampling: false,
    nativeSampleIntervalMs: 200,
    nativeObserverSha256: await fileHash(observer),
  },
  scope:
    'One controlled ordinary-keyboard session with a synthetic one-page resume and a fresh profile. Each cycle changes four visible revision digits, appends a comment, builds and exports the PDF, then idles for 2.5 seconds in Code or Chat. Startup/compiler preparation and final undo/redo are outside sampling. No explicit collection, heap snapshots or allocation sampling. Native totals are sampled process-tree observations, not unique physical bytes or complete CPU attribution. This does not qualify physical IME, AI edits, long documents, large existing histories or all supported Macs. Separate sequential modes are not randomized timing pairs.',
  phases: [],
  observations: [],
  pdfs: [],
  errors: [],
  passed: false,
};
console.log(`Session evidence: ${root}`);
const env = { ...process.env, FOLIO_USER_DATA: dataRoot };
delete env.ELECTRON_RUN_AS_NODE;
delete env.FOLIO_TEST_RUNTIME_SEED;
let app, page, session, sampler;
let expected = base;
const code = () => page.getByRole('tab', { name: 'Code', exact: true }).click();
const editor = () => page.locator('.cm-content');
const source = async () =>
  JSON.parse(await fs.readFile(path.join(dataRoot, 'recovery.json'), 'utf8')).project.files.find(
    (f) => f.path === 'main.tex',
  ).content;
const begin = async (name) => {
  const s = await sampler.mark(name);
  report.phases.push({ name, atMs: s.atMs, observedCpuSeconds: s.observedCpuSeconds });
};
const observe = async (label) => {
  const native = await sampler.mark(label);
  report.observations.push({
    label,
    atMs: native.atMs,
    dom: await session.send('Memory.getDOMCounters'),
    heap: await session.send('Runtime.getHeapUsage'),
    mainMemory: await app.evaluate(() => process.memoryUsage()),
    connectedEditorViews: await page.locator('.cm-editor').count(),
    native: {
      summedRssBytes: native.summedRssBytes,
      summedFootprintBytes: native.summedFootprintBytes,
      observedCpuSeconds: native.observedCpuSeconds,
    },
  });
};
try {
  app = await electron.launch({ executablePath, args: [], env, timeout: 120_000 });
  page = await app.firstWindow();
  page.setDefaultTimeout(30_000);
  page.on('pageerror', (e) => report.errors.push(e.message));
  page.on('console', (item) => {
    if (item.type() === 'error') report.errors.push(item.text());
  });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1480, 960));
  await expect(page.getByLabel('Message the resume agent')).toBeEnabled({ timeout: 180_000 });
  await expect(page.locator('.compiler-preparation')).toHaveCount(0, { timeout: 180_000 });
  await app.evaluate(({ dialog }, folder) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] });
  }, folder);
  await page.getByRole('button', { name: 'More project actions' }).click();
  await page.getByRole('menuitem', { name: 'Open project folder…', exact: true }).click();
  await code();
  await expect(editor()).toContainText('Ordinary edit number 0000.');
  await page.getByRole('checkbox', { name: 'Auto-compile', exact: true }).uncheck();
  await page.getByRole('button', { name: 'Compile', exact: true }).click();
  await expect(page.locator('.preview-pane .textLayer')).toContainText(
    'Ordinary edit number 0000.',
    { timeout: 60_000 },
  );
  await page.getByText('Up to date', { exact: true }).waitFor({ timeout: 60_000 });
  await expect.poll(source).toBe(base);
  report.applicationVersions = await app.evaluate(() => ({
    node: process.versions.node,
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    v8: process.versions.v8,
  }));
  session = await page.context().newCDPSession(page);
  sampler = new ProcessSampler(observer, app.process().pid, 200);
  await sampler.start();
  await observe('ready');
  for (let cycle = 1; cycle <= cycles; cycle++) {
    await begin(`cycle-${cycle}-typing`);
    await code();
    await expect(page.locator('.cm-editor')).toHaveCount(1);
    await editor().press('ControlOrMeta+Home');
    for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowDown');
    for (let i = 0; i < 'Ordinary edit number '.length + 4; i++)
      await page.keyboard.press('ArrowRight');
    for (let i = 0; i < 4; i++) await page.keyboard.press('Shift+ArrowLeft');
    const number = String(cycle).padStart(4, '0');
    await page.keyboard.type(number, { delay: 8 });
    await editor().press('ControlOrMeta+End');
    await page.keyboard.press('Enter');
    const comment = `% Edited sentence ${number} for this application.`;
    await page.keyboard.type(comment, { delay: 8 });
    expected =
      expected.replace(/Ordinary edit number \d{4}\./, `Ordinary edit number ${number}.`) +
      '\n' +
      comment;
    await expect.poll(source).toBe(expected);
    await begin(`cycle-${cycle}-build`);
    await page.getByRole('button', { name: 'Compile', exact: true }).click();
    await expect(page.locator('.preview-pane .pdf-sheet')).toHaveCount(1, { timeout: 60_000 });
    await expect(page.locator('.preview-pane .textLayer')).toContainText(
      `Ordinary edit number ${number}.`,
      { timeout: 60_000 },
    );
    await page.getByText('Up to date', { exact: true }).waitFor({ timeout: 60_000 });
    await begin(`cycle-${cycle}-export`);
    const pdf = path.join(root, `cycle-${number}.pdf`);
    await app.evaluate(({ dialog }, file) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: file });
    }, pdf);
    await page.getByRole('button', { name: 'Export PDF', exact: true }).click();
    await expect
      .poll(() =>
        fs
          .stat(pdf)
          .then((s) => s.size)
          .catch(() => 0),
      )
      .toBeGreaterThan(100);
    report.pdfs.push({
      cycle,
      path: pdf,
      source: expected,
      sourceSha256: hash(Buffer.from(expected)),
    });
    if (mode === 'chat') await page.getByRole('tab', { name: 'Chat', exact: true }).click();
    await expect(page.locator('.cm-editor')).toHaveCount(mode === 'chat' ? 0 : 1);
    await begin(`cycle-${cycle}-idle`);
    await new Promise((resolve) => setTimeout(resolve, 2500));
    await observe(`cycle-${cycle}-idle-end`);
    console.log(`Completed ${mode} cycle ${cycle}/${cycles}.`);
  }
  await begin('finished');
  await sampler.stop();
  // This correctness check is deliberately outside the resource observation.
  await code();
  await editor().focus();
  await editor().press('ControlOrMeta+z');
  await expect.poll(source).not.toBe(expected);
  await editor().press('ControlOrMeta+Shift+z');
  await expect.poll(source).toBe(expected);
  report.finalUndoRedoPreserved = true;
  await page.screenshot({ path: path.join(root, 'final.png') });
  await session.detach();
  session = undefined;
  const closed = page.waitForEvent('close');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  await closed;
  await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
  await app.close().catch(() => {});
  app = undefined;
  expect(await source()).toBe(expected);
  report.finalSourceSha256 = hash(Buffer.from(expected));
  const python = process.env.FOLIO_PYTHON ?? 'python3';
  for (const pdf of report.pdfs) {
    const parsed = JSON.parse(
      execFileSync(
        python,
        [
          '-c',
          'import sys,json;from pypdf import PdfReader;r=PdfReader(sys.argv[1]);print(json.dumps({"pages":len(r.pages),"text":"".join(p.extract_text() for p in r.pages)}))',
          pdf.path,
        ],
        { encoding: 'utf8' },
      ),
    );
    expect(parsed.pages).toBe(1);
    expect(parsed.text).toContain(`Ordinary edit number ${String(pdf.cycle).padStart(4, '0')}.`);
    pdf.sha256 = await fileHash(pdf.path);
    pdf.bytes = (await fs.stat(pdf.path)).size;
    pdf.parsed = parsed;
  }
  expect(await fileHash(asar)).toBe(report.appAsarSha256);
  expect(await fileHash(runtimeManifest)).toBe(report.runtimeManifestSha256);
  for (const file of scripts) expect(await fileHash(file)).toBe(report.scripts[file]);
  expect(hash(harness)).toBe(report.scripts['scripts/profile-editor-session.mjs']);
  expect(report.errors).toEqual([]);
  report.passed = true;
} catch (error) {
  report.errors.push(error.message);
  await page?.screenshot({ path: path.join(root, 'failure.png') }).catch(() => {});
  throw error;
} finally {
  await sampler?.stop().catch((e) => report.errors.push(e.message));
  await session?.detach().catch(() => {});
  await app?.evaluate(({ app }) => app.exit(0)).catch(() => {});
  await app?.close().catch(() => {});
  report.samples = sampler?.samples ?? [];
  report.finishedAt = new Date().toISOString();
  await fs.writeFile(path.join(root, 'measurements.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(`Evidence: ${root}`);
}
