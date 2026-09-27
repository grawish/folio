import { _electron as electron, expect } from '@playwright/test';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

// Opt-in real subscription test. Sends only the synthetic document below and
// its PDF images. Uses a new app profile and never reads an existing resume.
if (process.argv.slice(2).join(' ') !== '--live') {
  console.error(
    'Run node scripts/test-live-claude.mjs --live to use an existing Claude Code subscription. Build Folio first. This sends synthetic PDF images and consumes account usage.',
  );
  process.exit(2);
}
const root = await fs.mkdtemp(path.resolve('test-results/claude-native-'));
const dataRoot = path.join(root, 'app-data'),
  saved = path.join(root, 'saved');
await fs.mkdir(saved);
const source = String.raw`\documentclass{article}
\usepackage[margin=1in]{geometry}
\begin{document}
\section*{Taylor Example}
Engineer with experience building accessible tools.
\section*{Experience}
Built a document preview for a school project.
\newpage
\section*{Projects}
Community library website. Kept the existing catalogue easy to search.
\end{document}`;
const note = 'Change the Projects heading to Selected Projects. Keep everything else unchanged.';
const request =
  'Apply the attached note: change only the Projects heading to Selected Projects. Keep every other source character, factual claim and layout unchanged. Check both PDF pages before finishing.';
const expectedSource = source.replace('section*{Projects}', 'section*{Selected Projects}');
const env = { ...process.env, FOLIO_USER_DATA: dataRoot };
delete env.ELECTRON_RUN_AS_NODE;
const errors = [],
  stages = [],
  screenshots = [];
const event = (name, detail = {}) => {
  const entry = { at: new Date().toISOString(), name, ...detail };
  stages.push(entry);
  console.log(JSON.stringify(entry));
};
const hash = (value) => createHash('sha256').update(value).digest('hex');
let app, page, projectId, verified, execution;
const launch = async () => {
  app = await electron.launch({ args: [process.cwd()], env, timeout: 60_000 });
  page = await app.firstWindow();
  page.setDefaultTimeout(20_000);
  page.on('pageerror', (error) => errors.push(error.message));
  await expect(page.getByLabel('Message the resume agent')).toBeEnabled({ timeout: 120_000 });
  await expect(page.locator('.compiler-preparation')).toHaveCount(0, { timeout: 120_000 });
};
const capture = async (name) => {
  const file = path.join(root, name + '.png');
  await page.screenshot({ path: file });
  const bytes = await fs.readFile(file);
  screenshots.push({ file: name + '.png', bytes: bytes.length, sha256: hash(bytes) });
};
const workspace = () => page.evaluate((id) => window.folio.loadWorkspace(id), projectId);
const stop = async () => {
  if (!app) return;
  await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
  await app.close().catch(() => {});
  app = undefined;
};
try {
  await launch();
  await page.getByText('Up to date', { exact: true }).waitFor({ timeout: 60_000 });
  event('source-app-ready');
  await page.getByRole('tab', { name: 'Code', exact: true }).click();
  await page.locator('.cm-content').fill(source);
  await expect(page.locator('.preview-pane .pdf-sheet')).toHaveCount(2, { timeout: 60_000 });
  await page.getByText('Up to date', { exact: true }).waitFor({ timeout: 60_000 });
  await page.getByRole('checkbox', { name: 'Auto-compile', exact: true }).uncheck();
  await app.evaluate(({ dialog }, folder) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] });
  }, saved);
  await page.getByRole('button', { name: 'Save project', exact: true }).click();
  await expect(page.getByText('Saved locally', { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect
    .poll(async () => fs.readFile(path.join(saved, 'main.tex'), 'utf8').catch(() => ''), {
      timeout: 30_000,
    })
    .toBe(source);
  projectId = JSON.parse(await fs.readFile(path.join(saved, 'resume.project.json'), 'utf8')).id;
  await page.getByRole('tab', { name: 'Chat', exact: true }).click();
  await page.getByRole('button', { name: 'Open Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Add connection', exact: true }).click();
  await page.getByLabel('Connection type', { exact: true }).selectOption('claude-code');
  await page.getByLabel('Connection name', { exact: true }).fill('Claude live acceptance');
  await page.getByLabel('Model', { exact: true }).fill('sonnet');
  await page.getByLabel('Fast model', { exact: true }).fill('sonnet');
  await page.getByLabel('Capable model', { exact: true }).fill('sonnet');
  await page.getByRole('button', { name: 'Save connection', exact: true }).click();
  await page.getByRole('radio').click();
  await page.getByRole('button', { name: 'Test image support', exact: true }).click();
  await expect(page.getByText('Image support verified', { exact: true })).toBeVisible({
    timeout: 190_000,
  });
  await capture('settings');
  event('settings-subscription-image-check-passed');
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await page.getByRole('button', { name: 'Box an area', exact: true }).click();
  const heading = page
    .locator('.preview-pane .textLayer')
    .nth(1)
    .getByText('Projects', { exact: true });
  await heading.scrollIntoViewIfNeeded();
  const box = await heading.boundingBox();
  if (!box) throw new Error('Synthetic heading is not visible.');
  await page.mouse.move(box.x - 3, box.y - 3);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width + 3, box.y + box.height + 3, { steps: 8 });
  await page.mouse.up();
  await page.getByRole('textbox', { name: 'PDF note instructions' }).fill(note);
  await page.getByRole('button', { name: 'Save note', exact: true }).click();
  await expect.poll(async () => (await workspace()).annotations.length).toBe(1);
  expect((await workspace()).annotations[0].page).toBe(2);
  await page.getByRole('button', { name: 'Attach 1 to chat', exact: true }).click();
  await expect(page.locator('.chat-composer .chat-note-preview img')).toHaveCount(1, {
    timeout: 30_000,
  });
  await page.getByRole('textbox', { name: 'Message the resume agent' }).fill(request);
  await capture('annotation');
  event('synthetic-page-two-note-attached');
  const started = performance.now();
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect
    .poll(
      async () => {
        const state = await workspace();
        const answer = state.messages.find(
          (m) => m.role === 'assistant' && m.execution?.validation === 'visual',
        );
        if (state.messages.some((m) => m.role === 'assistant' && m.status === 'error'))
          throw new Error(
            'The live agent returned an error; retained workspace records the result.',
          );
        return !!answer;
      },
      { timeout: 360_000, intervals: [1000] },
    )
    .toBe(true);
  const state = await workspace();
  execution = state.messages.find(
    (m) => m.role === 'assistant' && m.execution?.validation === 'visual',
  ).execution;
  const version = state.versions.find((v) => v.verified);
  if (!version) throw new Error('No visually checked history version.');
  verified = await page.evaluate(({ id, versionId }) => window.folio.readVersion(id, versionId), {
    id: projectId,
    versionId: version.id,
  });
  expect(verified.files.find((f) => f.path === 'main.tex').content).toBe(expectedSource);
  await expect(page.locator('.preview-pane .textLayer').nth(1)).toContainText('Selected Projects');
  expect(state.messages.find((m) => m.role === 'user').annotationSnapshot[0].text).toBe(note);
  event('real-edit-compile-visual-review-passed', {
    elapsedMs: performance.now() - started,
    execution,
  });
  await capture('completed-chat');
  const pdfPath = path.join(root, 'export.pdf');
  await app.evaluate(({ dialog }, filePath) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath });
  }, pdfPath);
  await page.getByRole('button', { name: 'Export PDF', exact: true }).click();
  await expect
    .poll(
      async () =>
        fs
          .readFile(pdfPath)
          .then((b) => hash(b))
          .catch(() => ''),
      { timeout: 30_000 },
    )
    .toBe(hash(Buffer.from(Object.values(verified.pdf))));
  await page.getByRole('button', { name: 'Save project', exact: true }).click();
  await expect(page.getByText('Saved locally', { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect
    .poll(async () => fs.readFile(path.join(saved, 'main.tex'), 'utf8'), { timeout: 30_000 })
    .toBe(expectedSource);
  event('source-saved-and-exact-pdf-exported');
  const closed = page.waitForEvent('close', { timeout: 30_000 });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  await closed;
  await stop();
  await launch();
  await expect(page.getByRole('region', { name: 'External file changes' })).toHaveCount(0);
  await page.getByRole('tab', { name: 'Code', exact: true }).click();
  await expect(page.locator('.cm-content')).toHaveText(expectedSource, { useInnerText: true });
  await expect(page.getByRole('checkbox', { name: 'Auto-compile', exact: true })).not.toBeChecked();
  await page.getByRole('button', { name: 'Compile', exact: true }).click();
  await page.getByText('Up to date', { exact: true }).waitFor({ timeout: 60_000 });
  await page.getByRole('tab', { name: 'Chat', exact: true }).click();
  await expect(page.locator('.preview-pane .textLayer').nth(1)).toContainText('Selected Projects', {
    timeout: 60_000,
  });
  expect((await workspace()).messages.some((m) => m.execution?.validation === 'visual')).toBe(true);
  await capture('reopened');
  event('saved-source-and-conversation-reopened');
  expect(errors).toEqual([]);
  const report = {
    schemaVersion: 1,
    checkedAt: new Date().toISOString(),
    passed: true,
    sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    scriptSha256: hash(await fs.readFile(new URL(import.meta.url))),
    applicationSources: await Promise.all(
      [
        'electron/core/ai-provider.ts',
        'electron/core/ai-process.ts',
        'electron/core/agent.ts',
        'electron/core/ai-edits.ts',
        'electron/core/connections.ts',
      ].map(async (file) => ({ file, sha256: hash(await fs.readFile(file)) })),
    ),
    input: 'Fresh source build with isolated app data',
    liveAI: true,
    provider: 'claude-code',
    configuredModel: 'sonnet',
    apiKeyUsed: false,
    syntheticOnly: true,
    sourceSha256: hash(source),
    expectedSourceSha256: hash(expectedSource),
    exportPdfSha256: hash(await fs.readFile(pdfPath)),
    execution,
    stages,
    screenshots,
    errors,
    scope:
      'One real subscription workflow: Settings connection and image check, page-two visual note, exact source edit, local compilation, visual review, save, matching PDF export and reopen. Does not establish every model/account or signed-package/platform acceptance.',
  };
  await fs.writeFile(path.join(root, 'verification.json'), JSON.stringify(report, null, 2) + '\n');
  await fs.writeFile(
    'test-results/live-claude-native-location.json',
    JSON.stringify({ root }, null, 2) + '\n',
  );
  event('passed', { root });
} catch (error) {
  if (page) await capture('failure').catch(() => {});
  const state = projectId && page ? await workspace().catch(() => null) : null;
  await fs.writeFile(
    path.join(root, 'failure.json'),
    JSON.stringify(
      { passed: false, error: String(error), stages, errors, workspace: state },
      null,
      2,
    ) + '\n',
  );
  console.error(error);
  console.error('Evidence:', root);
  process.exitCode = 1;
} finally {
  await stop();
}
