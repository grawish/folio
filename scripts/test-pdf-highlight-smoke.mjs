import { _electron as electron, expect } from '@playwright/test';
import { promises as fs } from 'node:fs';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// A local model-protocol fixture replaces inference only. All source, compiler,
// history, PDF.js comparison, UI, IPC and export paths run normally.
const root = await fs.mkdtemp(path.resolve('test-results/pdf-highlight-'));
const dataRoot = path.join(root, 'data');
const executablePath = process.argv[2] && path.resolve(process.argv[2]);
const selected = process.argv[3] ?? 'all';
if (!['all', 'ordinary', 'delayed'].includes(selected))
  throw Error('Choose all, ordinary or delayed.');
const source = String.raw`\documentclass{article}
\usepackage[margin=1in]{geometry}
\begin{document}
\section*{Projects}
A community library website with an accessible search page.
\newpage
\section*{Skills}
Programming, clear writing, and testing with users.
\end{document}`;
const expectedSource = source
  .replace('section*{Projects}', 'section*{Selected Projects}')
  .replace('section*{Skills}', 'section*{Technical Skills}');
const removedSource = String.raw`\documentclass{article}
\usepackage[margin=1in]{geometry}
\begin{document}
\section*{Selected Projects}
A community library website with an accessible search page.
\end{document}`;
const insertedSource = String.raw`\documentclass{article}
\usepackage[margin=1in]{geometry}
\begin{document}
\section*{Selected Projects}
A community library website with an accessible search page.
\newpage
\section*{References}
Available on request.
\end{document}`;
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const harness = await fs.readFile(fileURLToPath(import.meta.url));
await fs.writeFile(path.join(root, 'harness.mjs'), harness);
const report = {
  sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  harnessSha256: hash(harness),
  harnessOrigin:
    'scripts/test-pdf-highlight-smoke.mjs at the recorded source commit; exact bytes retained as harness.mjs.',
  scope:
    'Synthetic native fixture with local scripted inference, real compiler and PDF comparison. A delayed workspace:version reply tests completion ordering without replacing the saved PDF. No real AI-account, performance or physical accessibility claim.',
  selected,
  requests: [],
  scenarios: [],
  errors: [],
  passed: false,
};
if (executablePath)
  report.appAsarSha256 = hash(
    await fs.readFile(path.resolve(path.dirname(executablePath), '../Resources/app.asar')),
  );
let scenario = 'setup';
const server = createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/v1/models') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ data: [{ id: 'highlight-fixture' }] }));
      return;
    }
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    const content = body.messages[1].content;
    const text = content.find((item) => item.type === 'text').text;
    const images = content.filter((item) => item.type === 'image_url').length;
    const prompt = text.startsWith('{') ? JSON.parse(text) : undefined;
    const type = !prompt ? 'connection-test' : prompt.candidateSource ? 'review' : 'edit';
    report.requests.push({ scenario, type, images, model: body.model });
    const target =
      type === 'edit' && prompt.request.includes('Remove the Skills page')
        ? { source: removedSource, message: 'Removed the Skills page.' }
        : type === 'edit' && prompt.request.includes('Add a References page')
          ? { source: insertedSource, message: 'Added a References page.' }
          : null;
    const answer = !prompt
      ? { color: 'red' }
      : type === 'review'
        ? { approved: true, issues: [], message: 'The PDF pages are readable.' }
        : target
          ? {
              message: target.message,
              needsInput: false,
              edits: prompt.source.map((file) => ({ ...file, content: target.source })),
            }
          : {
              message: 'Changed both headings and reviewed both PDF pages.',
              needsInput: false,
              edits: prompt.source.map((file) => ({
                ...file,
                content: file.content
                  .replace('section*{Projects}', 'section*{Selected Projects}')
                  .replace('section*{Skills}', 'section*{Technical Skills}'),
              })),
            };
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify({
        choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(answer) } }],
      }),
    );
  } catch (error) {
    report.errors.push(String(error));
    res.statusCode = 500;
    res.end('Synthetic inference fixture failed');
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const env = { ...process.env, FOLIO_USER_DATA: dataRoot };
delete env.ELECTRON_RUN_AS_NODE;
let app, page;
const ready = () => page.getByText('Up to date', { exact: true }).waitFor({ timeout: 60_000 });
const showChanges = () => page.getByRole('button', { name: /^Show changes \(/ });
const geometry = () =>
  page
    .locator('.pdf-change-region')
    .evaluateAll((nodes) =>
      nodes.map((node) => ({
        page: Number(node.closest('.pdf-sheet').dataset.page),
        left: node.style.left,
        top: node.style.top,
        width: node.style.width,
        height: node.style.height,
        kind: node.className,
      })),
    );
const pagesWithChanges = async () => [...new Set((await geometry()).map((r) => r.page))].sort();
const releaseHeldRead = async () => app?.evaluate(() => globalThis.folioHighlightRead?.release?.());
try {
  app = await electron.launch({
    ...(executablePath ? { executablePath, args: [] } : { args: [process.cwd()] }),
    env,
    timeout: 120_000,
  });
  page = await app.firstWindow();
  page.setDefaultTimeout(15_000);
  page.on('pageerror', (e) => report.errors.push(e.message));
  page.on('console', (item) => {
    if (item.type() === 'error') report.errors.push(item.text());
  });
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setContentSize(1480, 960),
  );
  await expect(page.getByLabel('Message the resume agent')).toBeEnabled({ timeout: 180_000 });
  await expect(page.locator('.compiler-preparation')).toHaveCount(0, { timeout: 180_000 });
  await ready();
  await page.getByRole('button', { name: 'Open Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Add connection', exact: true }).click();
  await page.getByLabel('Connection type', { exact: true }).selectOption('custom');
  await page.getByLabel('Connection name', { exact: true }).fill('Local highlight fixture');
  await page
    .getByLabel('Base URL', { exact: true })
    .fill(`http://127.0.0.1:${server.address().port}/v1`);
  for (const name of ['Model', 'Fast model', 'Capable model'])
    await page.getByLabel(name, { exact: true }).fill('highlight-fixture');
  await page.getByLabel(/^API key/).fill('synthetic-highlight-key');
  await page.getByRole('button', { name: 'Save connection', exact: true }).click();
  await page.getByRole('radio').click();
  await page.getByRole('button', { name: 'Test image support', exact: true }).click();
  await expect(page.getByText('Image support verified', { exact: true })).toBeVisible({
    timeout: 30_000,
  });
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(page.locator('dialog[open]')).toHaveCount(0);
  for (const mode of selected === 'all' ? ['ordinary', 'delayed'] : [selected]) {
    scenario = mode;
    const folder = path.join(root, mode);
    await fs.mkdir(folder);
    await fs.writeFile(path.join(folder, 'main.tex'), source);
    await app.evaluate(({ dialog }, folder) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] });
    }, folder);
    await page.getByRole('button', { name: 'More project actions' }).click();
    await page.getByRole('menuitem', { name: 'Open project folder…', exact: true }).click();
    await page.getByRole('tab', { name: 'Code', exact: true }).click();
    await expect(page.locator('.cm-content')).toContainText('section*{Projects}');
    await page.getByRole('checkbox', { name: 'Auto-compile', exact: true }).uncheck();
    await page.getByRole('button', { name: 'Compile', exact: true }).click();
    await ready();
    await expect(page.locator('.pdf-sheet')).toHaveCount(2);
    await page.getByRole('button', { name: 'Save project', exact: true }).click();
    await page.getByText('Saved locally', { exact: true }).waitFor();
    const projectId = JSON.parse(
      await fs.readFile(path.join(folder, 'resume.project.json'), 'utf8'),
    ).id;
    await page.getByRole('tab', { name: 'Chat', exact: true }).click();
    await expect(showChanges()).toHaveCount(0);
    const result = { mode, projectId, checks: [], passed: false };
    report.scenarios.push(result);
    if (mode === 'delayed') {
      await app.evaluate(({ ipcMain }) => {
        const original = ipcMain._invokeHandlers.get('workspace:version');
        if (!original) throw Error('Missing real history read handler');
        globalThis.folioHighlightRead = { entered: false, released: false };
        ipcMain._invokeHandlers.set('workspace:version', async (...args) => {
          ipcMain._invokeHandlers.set('workspace:version', original);
          const reply = await original(...args);
          globalThis.folioHighlightRead.entered = true;
          await new Promise((resolve) => {
            globalThis.folioHighlightRead.release = () => {
              globalThis.folioHighlightRead.released = true;
              resolve();
            };
          });
          return reply;
        });
      });
    }
    await page
      .getByLabel('Message the resume agent')
      .fill(
        'Change Projects to Selected Projects and Skills to Technical Skills. Check the layout on both pages.',
      );
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.locator('.chat-message.assistant')).toContainText('Changed both headings', {
      timeout: 60_000,
    });
    await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0, {
      timeout: 30_000,
    });
    await ready();
    if (mode === 'delayed') {
      await expect.poll(() => app.evaluate(() => globalThis.folioHighlightRead.entered)).toBe(true);
      await expect(showChanges()).toHaveCount(0);
      await releaseHeldRead();
      result.checks.push(
        'Real before-version reply held until the AI completion UI settled, then released.',
      );
    }
    await expect(showChanges()).toBeVisible({ timeout: 15_000 });
    await expect.poll(pagesWithChanges).toEqual([1, 2]);
    const regions = await geometry();
    expect(
      regions.every((r) =>
        ['left', 'top', 'width', 'height'].every(
          (k) =>
            r[k].endsWith('%') &&
            Number.isFinite(parseFloat(r[k])) &&
            parseFloat(r[k]) >= 0 &&
            parseFloat(r[k]) <= 100,
        ),
      ),
    ).toBe(true);
    result.regions = regions;
    await showChanges().click();
    await expect(page.locator('.pdf-change-flash.visible').first()).toBeVisible();
    await page.screenshot({ path: path.join(root, `${mode}-changes.png`) });
    await expect(page.locator('.pdf-change-flash').first()).toHaveClass(/hidden/, {
      timeout: 5_000,
    });
    await showChanges().click();
    await expect(page.locator('.pdf-change-flash.visible').first()).toBeVisible();
    await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
    await expect.poll(geometry).toEqual(regions);
    await page.getByRole('button', { name: 'Fit to width', exact: true }).click();
    for (let n = 0; n < regions.length + 1; n++) {
      await page.getByRole('button', { name: 'Next change', exact: true }).click();
      if ((await page.locator('.page-controls').innerText()).includes('2 / 2')) break;
    }
    await expect(page.locator('.page-controls')).toContainText('2 / 2');
    await expect(page.getByRole('button', { name: 'Previous change', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: 'Previous change', exact: true }).click();
    await expect(page.locator('.page-controls')).toContainText('1 / 2');
    const workspace = await page.evaluate((id) => window.folio.loadWorkspace(id), projectId);
    const version = workspace.versions.at(-1);
    const retained = await page.evaluate(
      ({ id, versionId }) => window.folio.readVersion(id, versionId),
      { id: projectId, versionId: version.id },
    );
    expect(retained.files.find((f) => f.path === 'main.tex').content).toBe(expectedSource);
    const pdf = path.join(root, `${mode}-export.pdf`);
    await app.evaluate(({ dialog }, filePath) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath });
    }, pdf);
    await showChanges().click();
    await page.getByRole('button', { name: 'Export PDF', exact: true }).click();
    await expect
      .poll(() =>
        fs
          .stat(pdf)
          .then((s) => s.size)
          .catch(() => 0),
      )
      .toBeGreaterThan(100);
    const bytes = await fs.readFile(pdf);
    expect(bytes).toEqual(Buffer.from(Object.values(retained.pdf)));
    result.exportSha256 = hash(bytes);
    result.savedSourceSha256 = hash(Buffer.from(expectedSource));
    result.versionId = version.id;
    expect(
      report.requests.some((r) => r.scenario === mode && r.type === 'review' && r.images === 2),
    ).toBe(true);
    result.checks.push(
      'Real AI edit and two-page image review; normalized regions, timed fade, replay, zoom, change navigation and byte-identical highlight-free export.',
    );
    await page.getByRole('button', { name: 'Save project', exact: true }).click();
    await page.getByText('Saved locally', { exact: true }).waitFor();
    expect(await fs.readFile(path.join(folder, 'main.tex'), 'utf8')).toBe(expectedSource);
    result.checks.push('The AI-edited source is saved to disk before another project is opened.');
    if (mode === 'ordinary') {
      const runEdit = async (message, confirmation) => {
        await page.getByLabel('Message the resume agent').fill(message);
        await page.getByRole('button', { name: 'Send', exact: true }).click();
        await expect(page.locator('.chat-message.assistant').last()).toContainText(confirmation, {
          timeout: 60_000,
        });
        await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0, {
          timeout: 30_000,
        });
        await ready();
      };
      await runEdit('Remove the Skills page entirely.', 'Removed the Skills page.');
      await expect(page.locator('.pdf-sheet')).toHaveCount(1);
      const marker = page.locator('.pdf-change-removed-marker');
      await expect(marker).toBeVisible({ timeout: 15_000 });
      await expect(marker).toHaveText('Page removed after this one');
      await showChanges().click();
      await expect(page.locator('.pdf-change-flash').first()).toHaveClass(/hidden/, {
        timeout: 5_000,
      });
      await expect(marker).toBeVisible();
      result.checks.push(
        'Native removed-page case: last surviving page carries the structural removed marker, and it outlives the timed flash.',
      );
      await runEdit('Add a References page at the end.', 'Added a References page.');
      await expect(page.locator('.pdf-sheet')).toHaveCount(2);
      await showChanges().click();
      await expect(page.locator('.pdf-change-page-outline')).toBeVisible({ timeout: 15_000 });
      await expect(page.locator('.pdf-change-page-label')).toHaveText('Inserted page');
      await expect(page.locator('.pdf-change-removed-marker')).toHaveCount(0);
      result.checks.push(
        'Native inserted-page case: the new page shows the inserted outline and label, and the stale removed marker is cleared.',
      );
      await page.getByRole('button', { name: 'Save project', exact: true }).click();
      await page.getByText('Saved locally', { exact: true }).waitFor();
    }
    result.passed = true;
  }
  expect(report.errors).toEqual([]);
  report.passed = true;
  console.log(
    'PASS: real PDF change regions, replay/navigation, delayed history reply and clean exported bytes.',
  );
} catch (error) {
  report.errors.push(error.message);
  await page?.screenshot({ path: path.join(root, 'failure.png') }).catch(() => {});
  throw error;
} finally {
  await releaseHeldRead().catch(() => {});
  await app?.evaluate(({ app }) => app.exit(0)).catch(() => {});
  await app?.close().catch(() => {});
  await new Promise((resolve) => server.close(resolve));
  report.finishedAt = new Date().toISOString();
  await fs.writeFile(path.join(root, 'result.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(`Evidence: ${root}`);
}
