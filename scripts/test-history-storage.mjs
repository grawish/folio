import { _electron as electron, expect } from '@playwright/test';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { unzipSync, strFromU8 } from 'fflate';

const root = await fs.mkdtemp(path.resolve('test-results/history-storage-'));
const data = path.join(root, 'data'),
  folder = path.join(root, 'project');
await fs.mkdir(folder);
const env = { ...process.env, FOLIO_USER_DATA: data };
delete env.ELECTRON_RUN_AS_NODE;
let app, page, projectId;
const errors = [],
  checks = [];
const readWorkspace = async () =>
  JSON.parse(await fs.readFile(path.join(data, 'workspaces', projectId, 'state.json'), 'utf8'));
const readRecovery = async () =>
  JSON.parse(await fs.readFile(path.join(data, 'recovery.json'), 'utf8')).project;
const ready = () => page.getByText('Up to date', { exact: true }).waitFor({ timeout: 60000 });
const code = () => page.getByRole('tab', { name: 'Code', exact: true }).click();
const chat = () => page.getByRole('tab', { name: 'Chat', exact: true }).click();
const openHistory = () => page.getByRole('button', { name: 'History', exact: true }).click();
const closeHistory = () => page.getByRole('button', { name: 'Close dialog', exact: true }).click();
const selectVersion = async (number) => {
  await page
    .getByRole('navigation', { name: 'Saved versions' })
    .getByRole('button')
    .filter({
      has: page.locator('strong', {
        hasText: new RegExp(`^Version ${number}(?: · Current PDF)?$`),
      }),
    })
    .click();
};
const source = (n) =>
  `\\documentclass{article}\n\\begin{document}\nAlex Morgan\n\\section*{Experience}\nBuilt accessible tools. Draft ${n}.\n\\end{document}\n`;
async function launch() {
  app = await electron.launch({
    ...(process.argv[2]
      ? { executablePath: path.resolve(process.argv[2]), args: [] }
      : { args: [process.cwd()] }),
    env,
    timeout: 60000,
  });
  page = await app.firstWindow();
  page.setDefaultTimeout(15000);
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (item) => {
    if (item.type() === 'error') errors.push(item.text());
  });
  await expect(page.getByLabel('Message the resume agent')).toBeEnabled({ timeout: 120000 });
  await expect(page.locator('.compiler-preparation')).toHaveCount(0, { timeout: 120000 });
}
async function edit(text, build = true) {
  await code();
  const editor = page.locator('.cm-content');
  await editor.press('ControlOrMeta+a');
  await page.keyboard.insertText(text);
  await expect
    .poll(async () => (await readRecovery()).files.find((f) => f.path === 'main.tex').content)
    .toBe(text);
  if (build) {
    await page.getByRole('button', { name: 'Compile', exact: true }).click();
    await ready();
  }
  await chat();
}
try {
  await launch();
  await ready();
  await code();
  await page.getByLabel('Auto-compile', { exact: true }).uncheck();
  await chat();
  await app.evaluate(({ dialog }, folder) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] });
  }, folder);
  await edit(source(1));
  await page.getByRole('button', { name: 'Save project', exact: true }).click();
  await page.getByText('Saved locally', { exact: true }).waitFor();
  projectId = JSON.parse(await fs.readFile(path.join(folder, 'resume.project.json'), 'utf8')).id;
  // Create feedback through the actual annotation controls on a real PDF.
  await page.getByRole('button', { name: 'Add a PDF note', exact: true }).click();
  const bounds = await page
    .locator('.preview-pane .pdf-annotation-layer canvas')
    .first()
    .boundingBox();
  await page.mouse.click(bounds.x + bounds.width * 0.25, bounds.y + bounds.height * 0.25);
  await page
    .getByRole('textbox', { name: 'PDF note instructions' })
    .fill('Shorten this older draft');
  await page.getByRole('button', { name: 'Save note', exact: true }).click();
  await expect.poll(async () => (await readWorkspace()).annotations.length).toBe(1);
  const older = (await readWorkspace()).versions.at(-1);
  await edit(source(2));
  await expect.poll(async () => (await readWorkspace()).versions.at(-1).id).not.toBe(older.id);
  const latest = (await readWorkspace()).versions.at(-1);
  const sourceBefore = await fs.readFile(path.join(folder, 'main.tex'));
  const currentPdf = await fs.readFile(
    path.join(data, 'workspaces', projectId, 'versions', latest.id, 'resume.pdf'),
  );
  await edit(source(2) + '% Unsaved source stays here\n', false);
  await page.getByLabel('Message the resume agent').fill('Keep my unfinished request');
  const before = await readWorkspace();
  await openHistory();
  await expect(page.locator('.history-storage')).toContainText('/ 64 MiB');
  await selectVersion(before.versions.length);
  await expect(
    page.getByRole('button', { name: 'Remove selected version…', exact: true }),
  ).toBeDisabled();
  const index = before.versions.findIndex((v) => v.id === older.id) + 1;
  await selectVersion(index);
  await expect(page.locator('.history-note')).toContainText('Shorten this older draft');
  await page.getByRole('button', { name: 'Remove selected version…', exact: true }).click();
  await expect(page.getByRole('group', { name: 'Confirm history removal' })).toContainText(
    'cannot be undone',
  );
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1040, 680));
  await page.getByRole('button', { name: 'Keep version', exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(root, 'history-removal-dark.png') });
  expect(await page.getByRole('dialog').evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(
    true,
  );
  await page.getByRole('button', { name: 'Keep version', exact: true }).click();
  expect((await readWorkspace()).versions.map((v) => v.id)).toEqual(
    before.versions.map((v) => v.id),
  );
  await closeHistory();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByLabel('Appearance', { exact: true }).selectOption('light');
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await openHistory();
  await selectVersion(index);
  await page.getByRole('button', { name: 'Remove selected version…', exact: true }).click();
  await page.getByRole('button', { name: 'Keep version', exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(root, 'history-removal-light.png') });
  await page.getByRole('button', { name: 'Remove this version', exact: true }).click();
  await expect(page.getByRole('group', { name: 'Confirm history removal' })).toHaveCount(0);
  await expect
    .poll(async () => (await readWorkspace()).versions.length)
    .toBe(before.versions.length - 1);
  const after = await readWorkspace();
  expect(after.annotations).toEqual([]);
  expect(after.draft).toBe('Keep my unfinished request');
  expect(await fs.readFile(path.join(folder, 'main.tex'))).toEqual(sourceBefore);
  expect(
    await fs.readFile(
      path.join(data, 'workspaces', projectId, 'versions', latest.id, 'resume.pdf'),
    ),
  ).toEqual(currentPdf);
  await expect(
    fs.access(path.join(data, 'workspaces', projectId, 'versions', older.id, 'resume.pdf')),
  ).rejects.toThrow();
  await closeHistory();
  expect((await readRecovery()).files.find((f) => f.path === 'main.tex').content).toContain(
    '% Unsaved source stays here',
  );
  await page.getByRole('button', { name: 'Save project', exact: true }).click();
  await expect
    .poll(
      async () =>
        JSON.parse(
          strFromU8(unzipSync(await fs.readFile(path.join(folder, 'resume.folio')))['state.json']),
        ).versions.length,
    )
    .toBe(after.versions.length);
  checks.push(
    'real PDF/note, current-version protection, compact dark/light confirmation, cancel, removal, unchanged current source/PDF, unsaved draft/source retention and portable save',
  );
  // Hold the real journal state replacement. Native close must wait for the
  // mutation and the renderer's new history revision before flushing recovery.
  await edit(source(3));
  await openHistory();
  await selectVersion(1);
  await page.getByRole('button', { name: 'Remove selected version…', exact: true }).click();
  const stateFile = path.join(data, 'workspaces', projectId, 'state.json');
  await app.evaluate((_, target) => {
    const fs = process.getBuiltinModule('node:fs').promises,
      rename = fs.rename.bind(fs);
    globalThis.historyHeld = false;
    fs.rename = async (from, to) => {
      if (to === target && String(from).includes('.save-')) {
        globalThis.historyHeld = true;
        await new Promise((resolve) => {
          globalThis.releaseHistory = resolve;
        });
      }
      return rename(from, to);
    };
  }, stateFile);
  await page.getByRole('button', { name: 'Remove this version', exact: true }).click();
  await expect.poll(() => app.evaluate(() => globalThis.historyHeld)).toBe(true);
  await expect(page.getByRole('button', { name: 'Close dialog', exact: true })).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Version history' })).toBeVisible();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1);
  const closed = page.waitForEvent('close');
  await app.evaluate(() => globalThis.releaseHistory());
  await closed;
  await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
  app = null;
  const final = await readWorkspace();
  expect(final.historyRevision).toBe(2);
  await launch();
  await expect(page.getByLabel('Message the resume agent')).toHaveValue(
    'Keep my unfinished request',
  );
  await openHistory();
  await expect(
    page.getByRole('navigation', { name: 'Saved versions' }).getByRole('button'),
  ).toHaveCount(final.versions.length);
  await expect(page.locator('.history-storage')).toContainText('/ 64 MiB');
  await closeHistory();
  checks.push(
    'held real journal write blocks Escape and native close; close resumes after commit and restart keeps the reduced history and chat draft',
  );
  expect(errors).toEqual([]);
  await fs.writeFile(
    path.join(root, 'result.json'),
    JSON.stringify({ passed: true, errors, checks }, null, 2),
  );
  for (const check of checks) console.log('PASS: ' + check);
} catch (error) {
  console.error(error);
  await page?.screenshot({ path: path.join(root, 'failure.png') }).catch(() => {});
  throw error;
} finally {
  if (app) await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
  console.log('Evidence: ' + root);
}
