// PERF-01 renderer idle-spike diagnostic (dedicated, developer-only).
//
// scripts/profile-process-resources.mjs --long-session runs have shown a rare
// renderer-dominated CPU exceedance during the standard 2.5-second
// `cycle-N-return-idle` dwell (exact phase name from that script): 3/361
// observed return-idle windows over 10% in one run, 2/361 in another, with
// the spiking process being the renderer helper (~12% of the window). A
// 20-cycle scripts/profile-v8-resources.mjs run, which brackets full V8 CPU
// profiling around every phase of every cycle, did not catch the event: its
// per-cycle overhead makes long enough runs impractical.
//
// This script trades that full-cycle instrumentation for narrow scope: it
// reuses the same workload shape and the same cheap native process sampler as
// profile-process-resources.mjs (so it can run far more cycles), and adds a
// renderer-only Chrome DevTools Protocol CPU profile bracketed tightly around
// each `cycle-N-return-idle` window only. A profile is written to disk only
// for windows whose native-sampled CPU crosses the same >10% threshold from
// the known evidence above.
//
// Scope and limitations (see report.scope/report.limits for the persisted
// copy): this NEVER establishes causality. A CPU profile captured during a
// spiking window shows what the renderer was doing while sampled, not why it
// happened, whether it reproduces the exact originally observed event, or
// that any single flagged frame is the cause. Garbage collection is ordinary
// throughout; nothing here forces or suppresses it. The diagnostic launches a
// fresh synthetic profile per run (like profile-process-resources.mjs), not
// the seed run's grown application state, so it cannot exercise
// history-size-dependent triggers. Native sampling is periodic
// (non-atomic, ~200ms) libproc/rusage accounting, not a tracing profiler;
// short sub-sample bursts can still be missed by the native side even when
// caught by the bracketed CDP profile, and vice versa.
import { _electron as electron, expect } from '@playwright/test';
import { promises as fs } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { buildProcessSampler, ProcessSampler } from './mac-process-sampler.mjs';
import { rendererIdleSpikeInputs } from './verify-renderer-idle-spikes.mjs';

const [executableArg, seedArg, cycleArg = '120'] = process.argv.slice(2);
const cycles = Number(cycleArg);
const hash = async (file) =>
  createHash('sha256')
    .update(await fs.readFile(file))
    .digest('hex');
const seed =
  process.platform === 'darwin' && seedArg
    ? await fs
        .readFile(path.join(path.resolve(seedArg), 'measurements.json'), 'utf8')
        .then(JSON.parse)
        .catch(() => null)
    : null;
const executablePath = executableArg ? path.resolve(executableArg) : undefined;
const asar = executablePath
  ? path.resolve(path.dirname(executablePath), '../Resources/app.asar')
  : undefined;
const appAsarSha256 = asar ? await hash(asar).catch(() => '') : '';
// Fail closed: never launch, never touch the app bundle, unless the exact
// wrong-app/wrong-seed identity guard accepts every input first.
rendererIdleSpikeInputs({
  platform: process.platform,
  arch: process.arch,
  executableArg,
  seedArg,
  argvLength: process.argv.length,
  cycles,
  seed,
  appAsarSha256,
});
const runtimeManifestSha256 = await hash(path.resolve(path.dirname(asar), 'runtime/manifest.json'));
const python = process.env.FOLIO_PYTHON ?? 'python3';
const pdfInspector = execFileSync(python, ['-c', 'import pypdf; print(pypdf.__version__)'], {
  encoding: 'utf8',
}).trim();
await fs.mkdir('test-results', { recursive: true });
const root = await fs.mkdtemp(path.resolve('test-results/renderer-idle-spikes-'));
const observer = await buildProcessSampler(root);
const thresholdPercent = 10;
const files = [
  'scripts/profile-renderer-idle-spikes.mjs',
  'scripts/verify-renderer-idle-spikes.mjs',
  'scripts/mac-process-sampler.mjs',
  'scripts/sample-mac-processes.c',
];
const report = {
  startedAt: new Date().toISOString(),
  sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  appAsarSha256,
  runtimeManifestSha256,
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
  seed: {
    report: path.join(path.resolve(seedArg), 'measurements.json'),
    appAsarSha256: seed.appAsarSha256,
    cycles: seed.cycles,
  },
  scope:
    'PERF-01 renderer idle-spike diagnostic. Targets only the standard 2.5-second cycle-N-return-idle dwell from profile-process-resources.mjs. Native process-sampler CPU accounting flags a window whenever the observed percentage of that window exceeds the known-evidence threshold; a renderer-only CDP CPU profile bracketed to exactly that window is persisted only for flagged windows. This is an observational diagnostic: a captured profile shows sampled renderer activity during a flagged window, not a proven cause, not a guaranteed reproduction of the original event, and not evidence about any other phase. Ordinary garbage collection throughout; nothing here forces or suppresses collection.',
  thresholdPercent,
  cycles,
  phases: [],
  pdfs: [],
  canvases: [],
  returnIdleObservations: [],
  errors: [],
  passed: false,
  limits: [
    'Sampling starts after Electron automation attaches; earliest process startup can be missed.',
    "Each run launches a fresh synthetic profile, not the seed run's grown application state; history-size-dependent triggers are out of scope.",
    'Native CPU accounting is periodic libproc/rusage sampling (~200ms), not a tracing profiler; sub-sample bursts can be missed on either side of a flagged/unflagged boundary.',
    'The renderer CDP CPU profile is bracketed only to the flagged cycle-N-return-idle window; work queued just before or after the boundary, in other processes, or in native code is not captured.',
    'A flagged window and its saved profile are correlational evidence only. They do not establish root cause, do not prove the flagged renderer activity caused the CPU exceedance, and do not guarantee reproduction of any previously observed spike.',
    'The sampling helper and Playwright harness run outside the app tree but add host load; the desktop is not otherwise isolated.',
    'Repeated single-Mac synthetic workloads do not establish spike rate, worst case, or population percentiles beyond what is directly observed in this run.',
  ],
};
let app, page, sampler, rendererSession;
const env = { ...process.env, FOLIO_USER_DATA: path.join(root, 'app-data') };
delete env.ELECTRON_RUN_AS_NODE;
delete env.FOLIO_TEST_RUNTIME_SEED;
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
const saveArtifact = async (name, value) => {
  const file = path.join(root, name);
  await fs.writeFile(file, JSON.stringify(value) + '\n');
  return { file, bytes: (await fs.stat(file)).size, sha256: await hash(file) };
};
// Per-process CPU delta across a finished phase's samples, from the raw
// native rows (not the cumulative-since-start total used for report.phases).
// Lets the renderer's own share of a return-idle window be isolated from
// other observed processes in the same window.
const perProcessDelta = (name) => {
  const inPhase = sampler.samples.filter((row) => row.phase === name);
  if (inPhase.length < 2) return null;
  const first = inPhase[0],
    last = inPhase.at(-1);
  const scale = first.timebase.numer / first.timebase.denom / 1e9;
  const totals = (processes) =>
    new Map(
      processes.map((row) => [
        `${row.pid}:${row.birthAbstime}`,
        {
          name: row.name,
          ticks: BigInt(row.userTicks) + BigInt(row.systemTicks),
        },
      ]),
    );
  const before = totals(first.processes);
  const after = totals(last.processes);
  const durationSeconds = (last.atMs - first.atMs) / 1000;
  const perProcess = [];
  for (const [key, info] of after) {
    const priorTicks = before.get(key)?.ticks ?? 0n;
    const deltaSeconds = Number(info.ticks - priorTicks) * scale;
    if (deltaSeconds > 0) perProcess.push({ name: info.name, cpuSeconds: deltaSeconds });
  }
  perProcess.sort((a, b) => b.cpuSeconds - a.cpuSeconds);
  const totalCpuSeconds = perProcess.reduce((sum, row) => sum + row.cpuSeconds, 0);
  return { durationSeconds, totalCpuSeconds, perProcess, samples: inPhase.length };
};
const returnIdle = async (cycle) => {
  const name = `cycle-${cycle}-return-idle`;
  await begin(name);
  await rendererSession.send('Profiler.start');
  await new Promise((resolve) => setTimeout(resolve, 2500));
  const { profile } = await rendererSession.send('Profiler.stop');
  const delta = perProcessDelta(name);
  const observation = { cycle, name, threshold: `>${thresholdPercent}%`, delta };
  if (delta) {
    const percent = (delta.totalCpuSeconds / delta.durationSeconds) * 100;
    const top = delta.perProcess[0];
    observation.totalCpuPercent = percent;
    observation.topProcess = top?.name;
    observation.topProcessCpuPercent = top ? (top.cpuSeconds / delta.durationSeconds) * 100 : 0;
    observation.isSpike = percent > thresholdPercent;
    if (observation.isSpike) {
      expect(profile.samples.length).toBeGreaterThan(0);
      observation.cpuProfile = await saveArtifact(`${name}-renderer.cpuprofile`, profile);
    }
  } else {
    observation.isSpike = false;
    observation.note = 'Fewer than two native samples landed inside this window.';
  }
  report.returnIdleObservations.push(observation);
  console.log(
    `${name}: ${delta ? observation.totalCpuPercent.toFixed(2) : '?'}% (${observation.topProcess ?? 'n/a'} ${delta ? observation.topProcessCpuPercent.toFixed(2) : '?'}%)${observation.isSpike ? ' SPIKE' : ''}`,
  );
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
  rendererSession = await page.context().newCDPSession(page);
  await rendererSession.send('Profiler.enable');
  await rendererSession.send('Profiler.setSamplingInterval', { interval: 1000 });
  await begin('ready-idle');
  await new Promise((resolve) => setTimeout(resolve, 2500));
  await page.getByRole('tab', { name: 'Code', exact: true }).click();
  await page.getByLabel('Auto-compile', { exact: true }).uncheck();
  for (let cycle = 1; cycle <= cycles; cycle++) {
    await compile(1, `Cycle ${cycle} small`);
    await begin(`cycle-${cycle}-small-idle`);
    await new Promise((resolve) => setTimeout(resolve, 2500));
    await compile(100, `Cycle ${cycle} long`);
    await begin(`cycle-${cycle}-navigation`);
    for (const number of [100, 50, 1]) {
      const sheet = page.locator(`.preview-pane .pdf-sheet[data-page="${number}"]`);
      await sheet.evaluate((node) => node.scrollIntoView({ block: 'start' }));
      await expect(sheet.locator('.textLayer')).toContainText(`Cycle ${cycle} long page ${number}`);
      await canvas(`cycle-${cycle}-page-${number}`);
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    await begin(`cycle-${cycle}-long-idle`);
    await new Promise((resolve) => setTimeout(resolve, 2500));
    await compile(1, `Cycle ${cycle} return`);
    await returnIdle(cycle);
    if (cycle % 10 === 0 || cycle === cycles) console.log(`Measured cycle ${cycle}/${cycles}.`);
  }
  await begin('finished');
  report.phases.pop();
  await sampler.stop();
  await rendererSession.send('Profiler.disable');
  await rendererSession.detach();
  rendererSession = undefined;
  await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
  await app.close().catch(() => {});
  app = undefined;
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
  await rendererSession?.detach().catch(() => {});
  await app?.evaluate(({ app }) => app.exit(0)).catch(() => {});
  await app?.close().catch(() => {});
  report.finishedAt = new Date().toISOString();
  report.samples = sampler?.samples ?? [];
  report.spikesDetected = report.returnIdleObservations.filter((row) => row.isSpike).length;
  report.observer.samples = report.samples.length;
  await fs.writeFile(path.join(root, 'measurements.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(
    `Evidence: ${root} (${report.spikesDetected ?? 0}/${report.returnIdleObservations.length} return-idle windows over ${thresholdPercent}%)`,
  );
}
