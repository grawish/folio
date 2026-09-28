import { _electron as electron, expect } from '@playwright/test';
import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import os from 'node:os';

if (process.platform !== 'darwin' || process.arch !== 'arm64' || !process.argv[2])
  throw new Error('Provide a packaged Folio executable on an Apple silicon Mac.');
const exec = promisify(execFile);
const executablePath = path.resolve(process.argv[2]);
const resources = path.resolve(path.dirname(executablePath), '../Resources');
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const hash = async (file) => sha(await fs.readFile(file));
const readJson = async (file) => JSON.parse(await fs.readFile(file, 'utf8'));
const exists = async (file) =>
  fs.lstat(file).then(
    () => true,
    (error) => {
      if (error.code === 'ENOENT') return false;
      throw error;
    },
  );
const python = process.env.FOLIO_PYTHON ?? 'python3';
const pdfInspector = JSON.parse(
  (
    await exec(python, [
      '-c',
      'import pypdf,json,sys; print(json.dumps({"python":sys.version,"pypdf":pypdf.__version__}))',
    ])
  ).stdout,
);
await fs.mkdir('test-results', { recursive: true });
const root = await fs.mkdtemp(path.resolve('test-results/build-crash-'));
const data = path.join(root, 'data'),
  saved = path.join(root, 'project');
await fs.mkdir(saved);
const before = String.raw`\documentclass{article}
\usepackage[margin=1in]{geometry}
\begin{document}
\section*{Taylor Example}
Before the crash. This source is saved in the project folder.
\end{document}`;
const interrupted = before
  .replace('Before the crash.', 'Unsaved editor draft.')
  .replace('\\end{document}', '\\loop\\iftrue\\repeat\n\\end{document}');
const after = before.replace('Before the crash.', 'Recovered after the crash.');
const draft = 'Please keep this chat draft while I review the recovered PDF.';
const report = {
  startedAt: new Date().toISOString(),
  sourceCommit: (await exec('git', ['rev-parse', 'HEAD'])).stdout.trim(),
  scriptSha256: await hash('scripts/test-build-crash.mjs'),
  appAsarSha256: await hash(path.join(resources, 'app.asar')),
  runtimeManifestSha256: await hash(path.join(resources, 'runtime/manifest.json')),
  host: {
    platform: process.platform,
    arch: process.arch,
    os: os.release(),
    cpu: os.cpus()[0].model,
  },
  pdfInspector,
  scope:
    'SIGKILL of an isolated packaged Electron main process during a real UI compile; fresh profile, production compiler, recovery, workspace and PDF export; no AI calls.',
  limits: [
    'Process interruption does not simulate physical power loss.',
    'One host observation is not a latency percentile or supported-device acceptance.',
    'The separate preferences suite covers the other workspace settings; physical power loss remains unverified.',
  ],
  checks: [],
  events: [],
  rendererErrors: [],
  passed: false,
};
const event = (type, details = {}) =>
  report.events.push({ at: new Date().toISOString(), type, ...details });
const env = { ...process.env, FOLIO_USER_DATA: data };
delete env.ELECTRON_RUN_AS_NODE;
// Always prepare a fresh profile, including during local iterations.
delete env.FOLIO_TEST_RUNTIME_SEED;
let app,
  page,
  projectId,
  nativeGroup,
  nativeMembers = [],
  nativeOutput = '';
const processes = async () => {
  const { stdout } = await exec('/bin/ps', ['-axo', 'pid=,ppid=,pgid=,lstart=,comm='], {
    maxBuffer: 8 * 1024 * 1024,
  });
  return stdout.split('\n').flatMap((line) => {
    const match = line.match(
      /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d+\s+\d+:\d+:\d+\s+\d+)\s+(.+)$/,
    );
    return match
      ? [
          {
            pid: Number(match[1]),
            parent: Number(match[2]),
            group: Number(match[3]),
            started: match[4].replace(/\s+/g, ' '),
            command: match[5],
          },
        ]
      : [];
  });
};
const sameProcess = (a, b) => a.pid === b.pid && a.started === b.started && a.command === b.command;
const recovery = () => readJson(path.join(data, 'recovery.json'));
const workspace = () => page.evaluate((id) => window.folio.loadWorkspace(id), projectId);
const code = () => page.getByRole('tab', { name: 'Code', exact: true }).click();
const chat = () => page.getByRole('tab', { name: 'Chat', exact: true }).click();
const editor = () => page.locator('.cm-content');
const composer = () => page.getByRole('textbox', { name: 'Message the resume agent' });
const auto = () => page.getByRole('checkbox', { name: 'Auto-compile', exact: true });
async function ready(text) {
  await expect(page.locator('.preview-pane .textLayer')).toContainText(text, { timeout: 60_000 });
  await page.getByText('Up to date', { exact: true }).waitFor({ timeout: 60_000 });
}
async function launch() {
  app = await electron.launch({ executablePath, args: [], env, timeout: 60_000 });
  const child = app.process();
  event('launch', { pid: child.pid });
  child.on('exit', (code, signal) => event('exit', { pid: child.pid, code, signal }));
  for (const stream of [child.stdout, child.stderr])
    stream?.on('data', (bytes) => {
      nativeOutput = (nativeOutput + bytes.toString()).slice(-65_536);
    });
  page = await app.firstWindow();
  page.setDefaultTimeout(20_000);
  page.on('pageerror', (error) => report.rendererErrors.push(error.message));
  page.on('console', (item) => {
    if (item.type() === 'error') report.rendererErrors.push(item.text());
  });
  await expect(composer()).toBeEnabled({ timeout: 120_000 });
  await expect(page.locator('.compiler-preparation')).toHaveCount(0, { timeout: 120_000 });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1480, 960));
}
async function save() {
  await app.evaluate(({ dialog }, folder) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] });
  }, saved);
  await page.getByRole('button', { name: 'Save project', exact: true }).click();
  await page.getByText('Saved locally', { exact: true }).waitFor();
}
async function snapshot() {
  const builds = path.join(data, 'builds');
  const owned = path.join(builds, '.folio-build-jobs-v1');
  if (await exists(owned))
    for (const name of await fs.readdir(owned)) {
      if (!/^job-[0-9a-f-]+$/.test(name)) continue;
      const directory = path.join(owned, name),
        source = path.join(directory, 'files/source/main.tex');
      if ((await exists(source)) && (await fs.readFile(source, 'utf8')) === interrupted)
        return {
          directory,
          source,
          layout: 'owned',
          owner: await readJson(path.join(directory, 'owner.json')),
        };
    }
  // Also recognize the old fixture layout so a baseline run reaches the actual
  // startup-removal assertion rather than failing merely on the folder name.
  for (const name of await fs.readdir(builds))
    if (name.startsWith('build-')) {
      const directory = path.join(builds, name),
        source = path.join(directory, 'source/main.tex');
      if ((await exists(source)) && (await fs.readFile(source, 'utf8')) === interrupted)
        return { directory, source, layout: 'legacy' };
    }
  return null;
}
try {
  await launch();
  await code();
  await editor().fill(before);
  await ready('Before the crash.');
  await auto().uncheck();
  await save();
  const manifest = await readJson(path.join(saved, 'resume.project.json'));
  projectId = manifest.id;
  report.runtimePin = manifest.runtime;
  const guards = Object.fromEntries(
    await Promise.all(
      ['main.tex', 'resume.project.json', 'resume.folio'].map(async (name) => [
        name,
        await hash(path.join(saved, name)),
      ]),
    ),
  );
  expect(await fs.readFile(path.join(saved, 'main.tex'), 'utf8')).toBe(before);
  const initialWorkspace = await workspace();
  expect(initialWorkspace.versions.length).toBeGreaterThan(0);
  const historyVersion = initialWorkspace.versions.at(-1).id;
  const history = () =>
    page.evaluate(
      async ({ id, versionId }) => {
        const value = await window.folio.readVersion(id, versionId);
        return Array.from(value.pdf);
      },
      { id: projectId, versionId: historyVersion },
    );
  const initialHistoryPdf = Buffer.from(await history());
  expect(initialHistoryPdf.subarray(0, 5).toString()).toBe('%PDF-');
  const historyHash = sha(initialHistoryPdf);
  report.history = {
    versionId: historyVersion,
    pdfSha256: historyHash,
    pdfBytes: initialHistoryPdf.length,
    versions: initialWorkspace.versions.length,
  };
  await chat();
  await composer().fill(draft);
  await expect.poll(async () => (await workspace()).draft).toBe(draft);
  await code();
  await editor().fill(interrupted);
  await expect
    .poll(async () => (await recovery()).project.files.find((f) => f.path === 'main.tex')?.content)
    .toBe(interrupted);
  await expect(auto()).not.toBeChecked();
  expect(await fs.readFile(path.join(saved, 'main.tex'), 'utf8')).toBe(before);
  await page.getByRole('button', { name: 'Compile', exact: true }).click();
  const main = app.process();
  let native;
  await expect
    .poll(
      async () => {
        native = (await processes()).find(
          (p) =>
            p.parent === main.pid &&
            p.group === p.pid &&
            p.command.startsWith(path.join(data, 'runtimes') + '/') &&
            p.command.endsWith('/tectonic'),
        );
        return !!native;
      },
      { timeout: 10_000, intervals: [25, 50, 100] },
    )
    .toBe(true);
  nativeGroup = native.group;
  nativeMembers = (await processes()).filter((p) => p.group === nativeGroup);
  expect(nativeMembers.some((p) => sameProcess(p, native))).toBe(true);
  const abandoned = await snapshot();
  expect(abandoned, 'The production compiler must have staged the edited source.').not.toBeNull();
  if (abandoned.owner) expect(abandoned.owner.pid).toBe(main.pid);
  report.interrupted = {
    mainPid: main.pid,
    native,
    nativeMembers,
    snapshot: abandoned,
    sourceSha256: sha(interrupted),
  };
  await page.screenshot({ path: path.join(root, 'during-compile.png') });
  const all = await processes(),
    descendants = new Set([main.pid]);
  for (let changed = true; changed;) {
    changed = false;
    for (const p of all)
      if (descendants.has(p.parent) && !descendants.has(p.pid)) {
        descendants.add(p.pid);
        changed = true;
      }
  }
  const helpers = all.filter((p) => p.pid !== main.pid && descendants.has(p.pid));
  const exited = new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('Owned app main did not exit after SIGKILL.')),
      10_000,
    );
    main.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
  const killedAt = performance.now();
  expect(main.kill('SIGKILL')).toBe(true);
  expect((await exited).signal).toBe('SIGKILL');
  app = undefined;
  await expect
    .poll(async () => (await processes()).filter((p) => p.group === nativeGroup), {
      timeout: 2_000,
      intervals: [25, 50, 100],
    })
    .toEqual([]);
  report.nativeGroupAbsentObservedMs = performance.now() - killedAt;
  await expect
    .poll(async () => (await processes()).filter((p) => helpers.some((h) => sameProcess(p, h))), {
      timeout: 10_000,
    })
    .toEqual([]);
  report.checks.push(
    'SIGKILL reached the real app main; the observed native group and captured app descendants exited without test cleanup.',
  );
  expect(
    await exists(abandoned.source),
    'Crash must leave a snapshot for startup recovery to remove.',
  ).toBe(true);
  for (const [name, digest] of Object.entries(guards))
    expect(await hash(path.join(saved, name))).toBe(digest);
  report.savedFileHashes = guards;
  await launch();
  await expect(composer()).toHaveValue(draft);
  await code();
  // A recently disabled automatic preview must stay disabled after main death;
  // reopening must not immediately replay the interrupted runaway source.
  report.autoCompileEnabledAfterCrash = await auto().isChecked();
  expect(report.autoCompileEnabledAfterCrash).toBe(false);
  await expect(page.getByRole('button', { name: 'Compile', exact: true })).toBeEnabled();
  await expect(editor()).toContainText('Unsaved editor draft.');
  await expect(editor()).toContainText('\\loop\\iftrue\\repeat');
  const recovered = (await recovery()).project;
  expect(recovered.id).toBe(projectId);
  expect(recovered.runtime).toEqual(manifest.runtime);
  expect(recovered.files.find((f) => f.path === 'main.tex').content).toBe(interrupted);
  expect((await workspace()).versions).toEqual(initialWorkspace.versions);
  expect(sha(Buffer.from(await history()))).toBe(historyHash);
  await expect
    .poll(() => exists(abandoned.directory), {
      message: 'Abandoned snapshot survived app restart.',
      timeout: 10_000,
    })
    .toBe(false);
  for (const [name, digest] of Object.entries(guards))
    expect(await hash(path.join(saved, name))).toBe(digest);
  report.checks.push(
    'Reopening retained the unsaved editor source, chat draft, project ID, compiler pin and PDF History; saved project files stayed byte-identical; startup removed the abandoned job.',
  );
  await editor().fill(after);
  await page.getByRole('button', { name: 'Compile', exact: true }).click();
  await ready('Recovered after the crash.');
  await save();
  expect(await fs.readFile(path.join(saved, 'main.tex'), 'utf8')).toBe(after);
  const exportPath = path.join(root, 'recovered.pdf');
  await app.evaluate(({ dialog }, filePath) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath });
  }, exportPath);
  await page.getByRole('button', { name: 'Export PDF', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('exported');
  const pdf = await fs.readFile(exportPath);
  expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
  const extracted = JSON.parse(
    (
      await exec(python, [
        '-c',
        'import pypdf,json,sys; d=pypdf.PdfReader(sys.argv[1]); print(json.dumps({"pages":len(d.pages),"text":"".join(p.extract_text() for p in d.pages)}))',
        exportPath,
      ])
    ).stdout,
  );
  expect(extracted.pages).toBe(1);
  expect(extracted.text).toContain('Recovered after the crash.');
  expect(extracted.text).not.toContain('Before the crash.');
  report.export = { file: 'recovered.pdf', sha256: sha(pdf), ...extracted };
  await chat();
  await expect(composer()).toHaveValue(draft);
  await page.getByRole('button', { name: 'Dismiss notification', exact: true }).click();
  await page.screenshot({ path: path.join(root, 'recovered-chat.png') });
  const jobs = await fs.readdir(path.join(data, 'builds/.folio-build-jobs-v1'));
  expect(jobs).toEqual([]);
  report.checks.push(
    'A fresh UI compile, save and export produced the new one-page PDF; its text was parsed independently; normal temporary-job cleanup completed.',
  );
  expect(report.rendererErrors).toEqual([]);
  expect(await hash(path.join(resources, 'app.asar'))).toBe(report.appAsarSha256);
  expect(await hash(path.join(resources, 'runtime/manifest.json'))).toBe(
    report.runtimeManifestSha256,
  );
  report.passed = true;
} catch (error) {
  report.error = error.stack ?? String(error);
  await page?.screenshot({ path: path.join(root, 'failure.png'), timeout: 5_000 }).catch(() => {});
  process.exitCode = 1;
} finally {
  if (app) {
    await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
    await app.close().catch(() => {});
  }
  // Clean a failed control only if a recorded process identity still proves
  // ownership. Never signal a group merely because its numeric ID matches.
  if (nativeGroup) {
    const remaining = (await processes()).filter((p) => p.group === nativeGroup);
    if (remaining.some((p) => nativeMembers.some((m) => sameProcess(p, m)))) {
      process.kill(-nativeGroup, 'SIGKILL');
      report.failureCleanup = { group: nativeGroup, remaining };
    }
  }
  report.finishedAt = new Date().toISOString();
  await fs.writeFile(path.join(root, 'native-output.log'), nativeOutput);
  await fs.writeFile(path.join(root, 'result.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(`Evidence: ${root}`);
  if (report.error) console.error(report.error);
}
