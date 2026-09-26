import { _electron as electron, expect } from '@playwright/test';
import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';

if (process.platform !== 'darwin' || process.arch !== 'arm64')
  throw new Error('Run on an Apple silicon Mac.');
if (!process.argv[2]) throw new Error('Provide the packaged Folio executable path.');
const executablePath = path.resolve(process.argv[2]);
const samples = Number(process.argv[3] ?? 5);
if (!Number.isInteger(samples) || samples < 1 || samples > 10)
  throw new Error('Choose 1–10 samples per template/paper variant.');
const smoke = process.argv[4] === '--smoke';
const sha = (data) => createHash('sha256').update(data).digest('hex');
const hash = async (file) => sha(await fs.readFile(file));
const python = process.env.FOLIO_PYTHON ?? 'python3';
const pdfInspector = JSON.parse(
  execFileSync(
    python,
    [
      '-c',
      'import pypdf,json,sys; print(json.dumps({"python":sys.version,"pypdf":pypdf.__version__}))',
    ],
    { encoding: 'utf8' },
  ),
);
const catalog = JSON.parse(await fs.readFile('resources/templates/catalog.json', 'utf8'));
const asar = path.resolve(path.dirname(executablePath), '../Resources/app.asar');
await fs.mkdir('test-results', { recursive: true });
const root = await fs.mkdtemp(path.resolve('test-results/preview-profile-'));
await fs.mkdir(path.join(root, 'pdfs'));
const report = {
  startedAt: new Date().toISOString(),
  sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  scriptSha256: await hash('scripts/profile-preview.mjs'),
  appAsarSha256: await hash(asar),
  runtimeManifestSha256: await hash(path.resolve(path.dirname(asar), 'runtime/manifest.json')),
  catalogSha256: await hash('resources/templates/catalog.json'),
  host: {
    platform: process.platform,
    arch: process.arch,
    os: os.release(),
    cpu: os.cpus()[0].model,
    logicalCpus: os.cpus().length,
    ramBytes: os.totalmem(),
    node: process.version,
  },
  samplesPerVariant: samples,
  pdfInspector,
  smoke,
  scope:
    'Real keyboard edits in the packaged Code view, production IPC/compiler/history, and current PDF canvas/text rendering. No AI calls.',
  limits: [
    'A fresh isolated app profile is prepared before timing. Each variant is compiled once before its measured edits; these are warm builds, not cold-cache samples.',
    'All cases share one app/runtime/engine-cache session. OS caches are not purged; case order and every sample are retained.',
    'Input and DOM timing use one renderer performance clock. Two animation frames after current text and Up to date are a rendering opportunity, not a physical display measurement.',
    'Native IPC timing includes validation, assets, compiler and history checkpoint. Compiler duration is the production rounded field, not TeX-only time.',
    'The harness temporarily wraps the existing private Electron IPC handler, preserving its event, arguments, result and errors. This is version-sensitive instrumentation, not a production API.',
    'Renderer timer/frame gaps are observations under automation, not proof of typing latency, OS CPU/memory quotas or full app resource budgets.',
    'Empirical percentiles describe this finite ordered corpus on one development Mac; they are not population p95 or acceptance on every supported device/OS.',
  ],
  variants: [],
  runs: [],
  errors: [],
  passed: false,
};
const write = () =>
  fs.writeFile(path.join(root, 'measurements.json'), JSON.stringify(report, null, 2) + '\n');
const env = { ...process.env, FOLIO_USER_DATA: path.join(root, 'app-data') };
delete env.ELECTRON_RUN_AS_NODE;
delete env.FOLIO_TEST_RUNTIME_SEED;
let app, page;
try {
  app = await electron.launch({ executablePath, args: [], env, timeout: 120_000 });
  page = await app.firstWindow();
  page.on('pageerror', (error) => report.errors.push(error.message));
  page.on('console', (item) => {
    if (item.type() === 'error') report.errors.push(item.text());
  });
  await expect(page.getByLabel('Message the resume agent')).toBeEnabled({ timeout: 120_000 });
  await page.getByText('Up to date', { exact: true }).waitFor({ timeout: 120_000 });
  report.viewport = await page.evaluate(() => ({
    width: innerWidth,
    height: innerHeight,
    devicePixelRatio,
  }));
  await app.evaluate(({ ipcMain }) => {
    const original = ipcMain._invokeHandlers?.get('build:compile');
    if (typeof original !== 'function')
      throw new Error('Expected compiler handler is unavailable.');
    globalThis.__folioProfileOriginal = original;
    globalThis.__folioProfileNative = [];
    ipcMain._invokeHandlers.set('build:compile', async (...args) => {
      const key = globalThis.__folioProfileKey;
      const start = performance.now();
      const result = await original(...args);
      if (key)
        globalThis.__folioProfileNative.push({
          key,
          nativeIpcMs: performance.now() - start,
          project: args[1],
          result,
        });
      return result;
    });
  });
  for (const paper of smoke ? ['a4'] : ['a4', 'letter']) {
    for (const template of smoke ? catalog.slice(0, 1) : catalog) {
      await page.getByRole('button', { name: 'Explore templates', exact: true }).click();
      await page.getByLabel('Paper size', { exact: true }).selectOption(paper);
      await page
        .getByRole('button', { name: `Create ${template.name} resume`, exact: true })
        .click();
      const discard = page.getByRole('button', { name: 'Discard changes', exact: true });
      if (await discard.isVisible()) await discard.click();
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await page.getByText('Up to date', { exact: true }).waitFor({ timeout: 60_000 });
      await expect(page.locator('.preview-pane .textLayer')).toContainText(template.sampleName);
      await page.getByRole('tab', { name: 'Code', exact: true }).click();
      await expect(page.getByLabel('Auto-compile', { exact: true })).toBeChecked();
      const originalSource = await fs.readFile(`resources/templates/${template.id}.tex`, 'utf8');
      const source = originalSource.replace(
        /^(\\documentclass\[[^\]\n]*)(a4|letter)paper/m,
        `$1${paper}paper`,
      );
      expect(source).toContain(`${paper}paper`);
      const variant = `${template.id}-${paper}`;
      report.variants.push({
        variant,
        sourceSha256: sha(source),
        templateSourceSha256: sha(originalSource),
      });
      for (let sample = 1; sample <= samples; sample++) {
        const key = `${variant}-${sample}`;
        const marker = `Sample ${String(sample).padStart(2, '0')}`;
        const edited = source.replace(template.sampleName, marker);
        expect(edited).not.toBe(source);
        const run = { variant, sample, key, marker, sourceSha256: sha(edited), passed: false };
        report.runs.push(run);
        await app.evaluate((_, key) => {
          globalThis.__folioProfileKey = key;
          globalThis.__folioProfileNative = [];
        }, key);
        const editor = page.locator('.cm-content');
        await editor.click();
        await editor.press('ControlOrMeta+a');
        await page.evaluate((marker) => {
          const data = { inputEvents: 0, states: [], maxTimerLatenessMs: 0, maxFrameGapMs: 0 };
          let started,
            compileStart,
            compileEnd,
            textAt,
            readyAt,
            frame,
            lastFrame,
            pending = false;
          const input = (event) => {
            if (!event.target.closest?.('.cm-content')) return;
            data.inputEvents++;
            started ??= performance.now();
          };
          document.addEventListener('beforeinput', input, true);
          const check = () => {
            if (started === undefined) return;
            const now = performance.now();
            const compiling = !!document.querySelector('.compile-button.is-building');
            if (compiling) compileStart ??= now;
            else if (compileStart !== undefined) compileEnd ??= now;
            const state = document
              .querySelector('.preview-heading .preview-state')
              ?.textContent.trim();
            if (state !== data.states.at(-1)?.state)
              data.states.push({ state, elapsedMs: now - started });
            const text = [...document.querySelectorAll('.preview-pane .textLayer')]
              .map((e) => e.textContent)
              .join(' ');
            if (text.includes(marker)) textAt ??= now;
            if (compileEnd !== undefined && text.includes(marker) && state === 'Up to date') {
              readyAt ??= now;
              if (!pending) {
                pending = true;
                requestAnimationFrame(() =>
                  requestAnimationFrame(() => {
                    data.inputToCompileUiMs = compileStart - started;
                    data.compileUiSpanMs = compileEnd - compileStart;
                    data.compileUiEndToReadyMs = readyAt - compileEnd;
                    data.inputToTextMs = textAt - started;
                    data.inputToReadyMs = readyAt - started;
                    data.inputToTwoFramesMs = performance.now() - started;
                    data.afterDebounceUiMs = data.inputToTwoFramesMs - data.inputToCompileUiMs;
                    data.done = true;
                    cleanup();
                  }),
                );
              }
            }
          };
          const observer = new MutationObserver(check);
          observer.observe(document.body, {
            childList: true,
            subtree: true,
            characterData: true,
            attributes: true,
            attributeFilter: ['class'],
          });
          let deadline = performance.now() + 10;
          const timer = setInterval(() => {
            const now = performance.now();
            if (started !== undefined)
              data.maxTimerLatenessMs = Math.max(data.maxTimerLatenessMs, now - deadline);
            deadline = now + 10;
          }, 10);
          const tick = (now) => {
            if (started !== undefined && lastFrame !== undefined)
              data.maxFrameGapMs = Math.max(data.maxFrameGapMs, now - lastFrame);
            lastFrame = now;
            frame = requestAnimationFrame(tick);
          };
          frame = requestAnimationFrame(tick);
          const cleanup = () => {
            observer.disconnect();
            clearInterval(timer);
            cancelAnimationFrame(frame);
            document.removeEventListener('beforeinput', input, true);
          };
          globalThis.__folioPreviewTiming = data;
          globalThis.__folioPreviewCleanup = cleanup;
        }, marker);
        await page.keyboard.insertText(edited);
        await page.waitForFunction(() => globalThis.__folioPreviewTiming.done, undefined, {
          timeout: 45_000,
        });
        Object.assign(run, await page.evaluate(() => globalThis.__folioPreviewTiming));
        expect(run.inputEvents).toBe(1);
        const native = await app.evaluate(() => {
          globalThis.__folioProfileKey = undefined;
          return globalThis.__folioProfileNative.map(({ key, nativeIpcMs, project, result }) => ({
            key,
            nativeIpcMs,
            project,
            status: result.status,
            revision: result.revision,
            compilerMs: result.durationMs,
            versionId: result.versionId,
            pdf: [...(result.pdf ?? [])],
          }));
        });
        expect(native).toHaveLength(1);
        const measured = native[0];
        expect(measured.key).toBe(key);
        expect(measured.status).toBe('success');
        expect(measured.versionId).toBeTruthy();
        expect(measured.project.files).toEqual([{ path: 'main.tex', content: edited }]);
        expect(measured.project.templateId).toBe(template.id);
        expect(measured.revision).toBe(measured.project.revision);
        const pdf = Buffer.from(measured.pdf);
        const file = path.join(root, 'pdfs', `${key}.pdf`);
        await fs.writeFile(file, pdf);
        const pdfInfo = JSON.parse(
          execFileSync(
            python,
            [
              '-c',
              'import pypdf,json,sys; d=pypdf.PdfReader(sys.argv[1]); print(json.dumps({"text":"".join(p.extract_text() for p in d.pages),"pages":len(d.pages),"width":float(d.pages[0].mediabox.width),"height":float(d.pages[0].mediabox.height)}))',
              file,
            ],
            { encoding: 'utf8' },
          ),
        );
        expect(pdfInfo.text).toContain(marker);
        run.pdfPages = pdfInfo.pages;
        expect(run.pdfPages).toBe(1);
        expect(Math.abs(pdfInfo.width - (paper === 'a4' ? 595.276 : 612))).toBeLessThan(0.2);
        expect(Math.abs(pdfInfo.height - (paper === 'a4' ? 841.89 : 792))).toBeLessThan(0.2);
        Object.assign(run, {
          nativeIpcMs: measured.nativeIpcMs,
          compilerMs: measured.compilerMs,
          nativeNonCompilerMs: measured.nativeIpcMs - measured.compilerMs,
          pdfSha256: sha(pdf),
          pdfBytes: pdf.length,
          exactSourceMatches: true,
          passed: true,
        });
        expect(report.errors).toEqual([]);
        await write();
        console.log(
          `${key}: input-to-PDF ${run.inputToTwoFramesMs.toFixed(0)} ms, after debounce ${run.afterDebounceUiMs.toFixed(0)} ms, compiler ${run.compilerMs} ms`,
        );
      }
    }
  }
  expect(await hash(asar)).toBe(report.appAsarSha256);
  expect(await hash('scripts/profile-preview.mjs')).toBe(report.scriptSha256);
  const values = (key) => report.runs.map((run) => run[key]).sort((a, b) => a - b);
  report.summary = Object.fromEntries(
    [
      'inputToTwoFramesMs',
      'afterDebounceUiMs',
      'inputToCompileUiMs',
      'compilerMs',
      'nativeNonCompilerMs',
      'compileUiEndToReadyMs',
      'maxTimerLatenessMs',
      'maxFrameGapMs',
    ].map((key) => {
      const sorted = values(key);
      return [
        key,
        {
          count: sorted.length,
          min: sorted[0],
          median:
            (sorted[Math.floor((sorted.length - 1) / 2)] +
              sorted[Math.ceil((sorted.length - 1) / 2)]) /
            2,
          empiricalP95: sorted[Math.ceil(sorted.length * 0.95) - 1],
          max: sorted.at(-1),
        },
      ];
    }),
  );
  report.passed = true;
} catch (error) {
  report.errors.push(error.message);
  await page?.screenshot({ path: path.join(root, 'failure.png') }).catch(() => {});
  throw error;
} finally {
  await page?.evaluate(() => globalThis.__folioPreviewCleanup?.()).catch(() => {});
  await app
    ?.evaluate(({ ipcMain }) => {
      if (globalThis.__folioProfileOriginal)
        ipcMain._invokeHandlers.set('build:compile', globalThis.__folioProfileOriginal);
    })
    .catch(() => {});
  if (page && app) {
    const closed = page.waitForEvent('close', { timeout: 15_000 }).catch(() => {});
    await app
      .evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close())
      .catch(() => {});
    await closed;
  }
  await app?.evaluate(({ app }) => app.exit(0)).catch(() => {});
  await app?.close().catch(() => {});
  report.finishedAt = new Date().toISOString();
  await write();
  console.log(`Evidence: ${root}`);
}
