import { _electron as electron, expect } from '@playwright/test';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { fork, execFileSync } from 'node:child_process';
import { tsImport } from 'tsx/esm/api';

const script = fileURLToPath(import.meta.url);
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const hashFile = async (file) => hash(await fs.readFile(file));
const readJson = async (file) => JSON.parse(await fs.readFile(file, 'utf8'));
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const storeName = '.folio-build-jobs-v1';
// A separate real owner creates production-format jobs and remains alive until
// the harness kills it. Never invent an owner PID or rewrite ownership records.
if (process.argv[2] === '--stage') {
  const [root, countText, bytesText] = process.argv.slice(3);
  const count = Number(countText),
    bytes = Number(bytesText);
  if (
    !process.send ||
    !Number.isInteger(count) ||
    count < 1 ||
    count > 1000 ||
    ![16384, 16777216].includes(bytes)
  )
    throw new Error('Invalid isolated fixture.');
  const { BuildWorkspaces } = await tsImport(
    '../electron/core/build-workspaces.ts',
    import.meta.url,
  );
  const manager = new BuildWorkspaces(root);
  const ids = [];
  const payload = Buffer.alloc(bytes, 83);
  for (let i = 0; i < count; i++) {
    const job = await manager.create();
    const id = path.basename(path.dirname(job.path)).slice(4);
    const owner = await readJson(path.join(path.dirname(job.path), 'owner.json'));
    if (owner.pid !== process.pid || owner.id !== id) throw new Error('Owner identity mismatch.');
    await fs.mkdir(path.join(job.path, 'source'));
    await fs.writeFile(path.join(job.path, 'source/main.tex'), 'Synthetic abandoned source.\n');
    for (let j = 0; j < 4; j++)
      await fs.writeFile(path.join(job.path, `payload-${j}.bin`), payload);
    ids.push(id);
  }
  process.send({
    pid: process.pid,
    ids,
    jobs: count,
    files: count * 5,
    payloadBytes: count * 4 * bytes,
    sourceBytes: count * 27,
  });
  // The IPC channel keeps this child alive until the parent explicitly kills it.
} else {
  if (process.platform !== 'darwin' || process.arch !== 'arm64' || !process.argv[2])
    throw new Error('Provide a packaged Folio executable on an Apple silicon Mac.');
  const executablePath = path.resolve(process.argv[2]);
  const repetitions = Number(process.argv[3] ?? 3);
  if (!Number.isInteger(repetitions) || repetitions < 1 || repetitions > 5)
    throw new Error('Choose 1–5 repetitions.');
  const python = process.env.FOLIO_PYTHON ?? 'python3';
  const pdfInspector = execFileSync(python, ['-c', 'import pypdf; print(pypdf.__version__)'], {
    encoding: 'utf8',
  }).trim();
  await fs.mkdir('test-results', { recursive: true });
  const root = await fs.mkdtemp(path.resolve('test-results/build-recovery-profile-'));
  const data = path.join(root, 'data'),
    saved = path.join(root, 'project');
  const builds = path.join(data, 'builds'),
    store = path.join(builds, storeName);
  await fs.mkdir(saved);
  const asar = path.resolve(path.dirname(executablePath), '../Resources/app.asar');
  const runtime = path.resolve(path.dirname(asar), 'runtime/manifest.json');
  const report = {
    schemaVersion: 1,
    startedAt: new Date().toISOString(),
    sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    scriptSha256: await hashFile(script),
    buildWorkspacesSha256: await hashFile('electron/core/build-workspaces.ts'),
    appAsarSha256: await hashFile(asar),
    runtimeManifestSha256: await hashFile(runtime),
    host: {
      cpu: os.cpus()[0].model,
      logicalCpus: os.cpus().length,
      ramBytes: os.totalmem(),
      os: os.release(),
      macos: execFileSync('sw_vers', ['-productVersion'], { encoding: 'utf8' }).trim(),
      node: process.version,
    },
    pdfInspector,
    repetitions,
    samples: [],
    passed: false,
    limits: [
      'One isolated profile is prepared once through the real app and then reused after normal closes. Preparation is outside the measured samples; OS caches are not purged.',
      'Four synthetic fixtures rotate order each repetition: no abandoned jobs, 100 and 1000 small jobs, and one 64 MiB payload job. They use production ownership records but do not reproduce a real document workload or physical power loss.',
      'An external directory poll every 50 ms records when original job IDs disappear. These are launch-relative observations with polling and automation overhead, not pure cleanup execution timings.',
      'Main-process 20 ms timer observation begins after automation attaches; early startup and earlier stalls may be missed. Timer gaps include observer overhead and do not measure renderer frame times.',
      'This does not measure full process-tree memory/CPU, a population percentile, clean-device acceptance, whole-profile storage retention or an optimization speedup.',
      'Only the isolated staging child is force-killed; packaged apps are closed normally. Unknown job data and an outside guard must remain unchanged. No AI request is sent.',
    ],
  };
  const persist = () =>
    fs.writeFile(path.join(root, 'measurements.json'), JSON.stringify(report, null, 2) + '\n');
  const env = { ...process.env, FOLIO_USER_DATA: data };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.FOLIO_TEST_RUNTIME_SEED;
  let app,
    page,
    child,
    polling = false,
    pollPromise;
  const source = (label) => String.raw`\documentclass{article}
\begin{document}
\section*{Taylor Example}
${label}
\end{document}`;
  let expectedSource = source('Prepared profile.'),
    expectedDraft = '';
  const composer = () => page.getByLabel('Message the resume agent');
  const code = () => page.getByRole('tab', { name: 'Code', exact: true }).click();
  const chat = () => page.getByRole('tab', { name: 'Chat', exact: true }).click();
  const save = async () => {
    await app.evaluate(({ dialog }, folder) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] });
    }, saved);
    await page.getByRole('button', { name: 'Save project', exact: true }).click();
    await expect
      .poll(() =>
        fs.readFile(path.join(saved, 'main.tex'), 'utf8').catch((error) => {
          if (error.code === 'ENOENT') return null;
          throw error;
        }),
      )
      .toBe(expectedSource);
  };
  const ready = async (label) => {
    await expect(page.locator('.preview-pane .textLayer')).toContainText(label, {
      timeout: 120_000,
    });
    await page.getByText('Up to date', { exact: true }).waitFor({ timeout: 120_000 });
  };
  const close = async () => {
    const closed = page.waitForEvent('close');
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
    await closed;
    await app.close();
    app = undefined;
  };
  const attach = async (errors) => {
    app = await electron.launch({ executablePath, args: [], env, timeout: 120_000 });
    page = await app.firstWindow();
    page.setDefaultTimeout(20_000);
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (item) => {
      if (item.type() === 'error') errors.push(item.text());
    });
    await expect(composer()).toBeEnabled({ timeout: 120_000 });
  };
  const stage = async (fixture) => {
    if (!fixture.jobs) return { jobs: 0, files: 0, payloadBytes: 0, sourceBytes: 0, ids: [] };
    child = fork(script, ['--stage', builds, String(fixture.jobs), String(fixture.bytes)], {
      execArgv: [],
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    });
    const owned = child;
    const staged = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Staging timed out.')), 120_000);
      owned.once('message', (message) => {
        clearTimeout(timer);
        resolve(message);
      });
      owned.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      owned.once('exit', () => {
        clearTimeout(timer);
        reject(new Error('Staging child exited before kill.'));
      });
    });
    expect(staged.pid).toBe(owned.pid);
    const exited = new Promise((resolve) =>
      owned.once('exit', (code, signal) => resolve({ code, signal })),
    );
    expect(owned.kill('SIGKILL')).toBe(true);
    const exit = await exited;
    expect(exit.signal).toBe('SIGKILL');
    child = undefined;
    expect((await fs.readdir(store)).filter((name) => name.startsWith('job-')).length).toBe(
      fixture.jobs,
    );
    return { ...staged, exit };
  };
  try {
    report.preparation = { errors: [] };
    const preparedAt = performance.now();
    await attach(report.preparation.errors);
    await expect(page.locator('.compiler-preparation')).toHaveCount(0, { timeout: 120_000 });
    await code();
    await page.locator('.cm-content').fill(expectedSource);
    await ready('Prepared profile.');
    await page.getByRole('checkbox', { name: 'Auto-compile', exact: true }).uncheck();
    await save();
    await chat();
    await close();
    report.preparation.elapsedMs = performance.now() - preparedAt;
    expect(report.preparation.errors).toEqual([]);
    const guard = path.join(builds, 'unmarked-source.txt');
    const unknown = path.join(store, 'unknown-job');
    await fs.writeFile(guard, 'Keep this older unmarked source.\n');
    await fs.mkdir(unknown);
    await fs.writeFile(path.join(unknown, 'source.txt'), 'Keep this unrecognized directory.\n');
    const guards = {
      [guard]: await hashFile(guard),
      [path.join(unknown, 'source.txt')]: await hashFile(path.join(unknown, 'source.txt')),
    };
    const fixtures = [
      { name: 'empty', jobs: 0, bytes: 16384 },
      { name: '100-small', jobs: 100, bytes: 16384 },
      { name: '1000-small', jobs: 1000, bytes: 16384 },
      { name: 'one-large', jobs: 1, bytes: 16777216 },
    ];
    for (let repetition = 0; repetition < repetitions; repetition++) {
      const order = [...fixtures.slice(repetition % 4), ...fixtures.slice(0, repetition % 4)];
      for (const fixture of order) {
        const run = {
          repetition: repetition + 1,
          fixture: fixture.name,
          errors: [],
          passed: false,
          observations: [],
        };
        report.samples.push(run);
        run.staged = await stage(fixture);
        const ids = new Set(run.staged.ids);
        const start = performance.now();
        const elapsed = () => performance.now() - start;
        polling = true;
        pollPromise = (async () => {
          while (polling) {
            const names = await fs.readdir(store);
            const remaining = names.filter((name) =>
              ids.has(name.replace(/^(job|removing)-/, '')),
            ).length;
            run.observations.push({ elapsedMs: elapsed(), remaining });
            if (!remaining) {
              run.cleanupAbsentObservedMs = elapsed();
              return;
            }
            if (elapsed() > 120_000) throw new Error('Cleanup observation timed out.');
            await delay(50);
          }
        })();
        // Retain asynchronous errors until this sample joins the observer.
        pollPromise.catch(() => {});
        await attach(run.errors);
        run.chatReadyMs = elapsed();
        run.mainTimerStartedObservedMs = elapsed();
        await app.evaluate(() => {
          const state = { gaps: [], last: performance.now(), timer: null };
          state.timer = setInterval(() => {
            const now = performance.now();
            if (state.gaps.length < 10000) state.gaps.push(now - state.last);
            state.last = now;
          }, 20);
          globalThis.__folioRecoveryProfile = state;
        });
        await expect(composer()).toHaveValue(expectedDraft);
        const inputAt = elapsed();
        expectedDraft = `Synthetic draft ${repetition + 1} ${fixture.name}`;
        await composer().fill(expectedDraft);
        await expect(composer()).toHaveValue(expectedDraft);
        run.chatInputVerifiedMs = elapsed();
        run.chatInputObservationMs = elapsed() - inputAt;
        await code();
        await expect(
          page.getByRole('checkbox', { name: 'Auto-compile', exact: true }),
        ).not.toBeChecked();
        await expect(page.locator('.cm-content')).toHaveText(expectedSource, {
          useInnerText: true,
        });
        const label = `Recovery sample ${repetition + 1} ${fixture.name}.`;
        expectedSource = source(label);
        const editAt = elapsed();
        await page.locator('.cm-content').fill(expectedSource);
        await expect(page.locator('.cm-content')).toHaveText(expectedSource, {
          useInnerText: true,
        });
        run.editorInputVerifiedMs = elapsed();
        run.editorInputObservationMs = elapsed() - editAt;
        await save();
        run.savedSourceVerifiedMs = elapsed();
        await expect(page.locator('.compiler-preparation')).toHaveCount(0, { timeout: 120_000 });
        await page.getByRole('button', { name: 'Compile', exact: true }).click();
        run.compileRequestedMs = elapsed();
        await ready(label);
        run.pdfVerifiedMs = elapsed();
        await pollPromise;
        polling = false;
        const pdfPath = path.join(root, `${repetition + 1}-${fixture.name}.pdf`);
        await app.evaluate(({ dialog }, filePath) => {
          dialog.showSaveDialog = async () => ({ canceled: false, filePath });
        }, pdfPath);
        await page.getByRole('button', { name: 'Export PDF', exact: true }).click();
        await expect
          .poll(() =>
            fs.access(pdfPath).then(
              () => true,
              () => false,
            ),
          )
          .toBe(true);
        const pdf = JSON.parse(
          execFileSync(
            python,
            [
              '-c',
              'import pypdf,json,sys; d=pypdf.PdfReader(sys.argv[1]); print(json.dumps({"pages":len(d.pages),"text":"".join(p.extract_text() for p in d.pages)}))',
              pdfPath,
            ],
            { encoding: 'utf8' },
          ),
        );
        expect(pdf.pages).toBe(1);
        expect(pdf.text).toContain(label);
        run.pdf = { file: path.basename(pdfPath), sha256: await hashFile(pdfPath), ...pdf };
        run.mainTimerGapsMs = await app.evaluate(() => {
          const state = globalThis.__folioRecoveryProfile;
          clearInterval(state.timer);
          delete globalThis.__folioRecoveryProfile;
          return state.gaps;
        });
        run.mainTimerStoppedObservedMs = elapsed();
        run.maxObservedMainTimerLatenessMs = Math.max(
          0,
          ...run.mainTimerGapsMs.map((gap) => gap - 20),
        );
        for (const [file, digest] of Object.entries(guards))
          expect(await hashFile(file)).toBe(digest);
        expect(await fs.readdir(store)).toEqual(['unknown-job']);
        await chat();
        await expect(composer()).toHaveValue(expectedDraft);
        if (repetition === 0)
          await page.screenshot({ path: path.join(root, `${fixture.name}.png`) });
        await save();
        await close();
        const recovery = (await readJson(path.join(data, 'recovery.json'))).project;
        expect(recovery.files.find((f) => f.path === 'main.tex').content).toBe(expectedSource);
        run.recoverySha256 = await hashFile(path.join(data, 'recovery.json'));
        run.guardsPreserved = true;
        expect(run.errors).toEqual([]);
        run.passed = true;
        await persist();
        console.log(
          `${repetition + 1} ${fixture.name}: chat ${run.chatInputVerifiedMs.toFixed(1)} ms; save ${run.savedSourceVerifiedMs.toFixed(1)} ms; cleanup absent ${run.cleanupAbsentObservedMs.toFixed(1)} ms; PDF ${run.pdfVerifiedMs.toFixed(1)} ms`,
        );
      }
    }
    report.finalReopen = { errors: [], passed: false };
    await attach(report.finalReopen.errors);
    await expect(composer()).toHaveValue(expectedDraft);
    await code();
    await expect(page.locator('.cm-content')).toHaveText(expectedSource, { useInnerText: true });
    await close();
    expect(report.finalReopen.errors).toEqual([]);
    report.finalReopen.passed = true;
    expect(await hashFile(asar)).toBe(report.appAsarSha256);
    expect(await hashFile(runtime)).toBe(report.runtimeManifestSha256);
    report.passed = true;
  } catch (error) {
    report.error = error.stack ?? String(error);
    if (page && !page.isClosed())
      await page.screenshot({ path: path.join(root, 'failure.png') }).catch(() => {});
    throw error;
  } finally {
    polling = false;
    await pollPromise?.catch(() => {});
    if (child) child.kill('SIGKILL');
    await app?.evaluate(({ app }) => app.exit(0)).catch(() => {});
    await app?.close().catch(() => {});
    report.finishedAt = new Date().toISOString();
    await persist();
    console.log(`Evidence: ${root}`);
  }
}
