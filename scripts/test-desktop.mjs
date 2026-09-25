import { _electron as electron, expect } from '@playwright/test';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const root = path.resolve('test-results');
await fs.mkdir(root, { recursive: true });
const sandbox = await fs.mkdtemp(path.join(root, 'desktop-'));
const source = await fs.readFile('resources/templates/classic.tex', 'utf8');
const env = { ...process.env, FOLIO_USER_DATA: path.join(sandbox, 'app-data') };
delete env.ELECTRON_RUN_AS_NODE;
let app = await electron.launch({ args: [process.cwd()], env, timeout: 60_000 });
const errors = [];
try {
  const page = await app.firstWindow();
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await expect(page.getByLabel('Message the resume agent')).toBeEnabled({ timeout: 120_000 });
  await page.getByText('Up to date', { exact: true }).waitFor({ timeout: 60_000 });
  await expect(page.locator('.preview-pane .textLayer')).toContainText('Alex Morgan', {
    timeout: 20_000,
  });
  await page.screenshot({ path: path.join(root, 'workspace.png') });
  console.log('PASS: native app launches, compiles offline, and renders selectable PDF text.');

  await page.getByRole('button', { name: 'Explore templates' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.screenshot({ path: path.join(root, 'templates.png') });
  await page.getByRole('button', { name: 'Close dialog' }).click();
  await page.getByRole('tab', { name: 'Code', exact: true }).click();
  await page.locator('.cm-content').fill(source.replace('Alex Morgan', 'Sam Taylor'));
  await expect(page.locator('.preview-pane .textLayer')).toContainText('Sam Taylor', {
    timeout: 20_000,
  });
  console.log('PASS: unsaved source changes update the actual PDF.');

  await page.locator('.cm-content').fill(source.replace('Alex Morgan', '\\badcommand'));
  await page.getByText('Build needs attention', { exact: true }).waitFor({ timeout: 20_000 });
  await expect(page.locator('.diagnostic.error')).not.toHaveCount(0);
  await expect(page.locator('.preview-pane .textLayer')).toContainText('Sam Taylor');
  await expect(page.locator('.stale-note')).toBeVisible();
  console.log('PASS: errors show diagnostics while retaining the last successful preview.');

  await page.locator('.cm-content').fill(source.replace('Alex Morgan', 'Sam Taylor'));
  await page.getByText('Up to date', { exact: true }).waitFor({ timeout: 20_000 });
  await page.getByRole('button', { name: 'Close build output' }).click();
  const projectDir = path.join(sandbox, 'saved-project');
  await fs.mkdir(projectDir);
  const pdfPath = path.join(sandbox, 'resume.pdf');
  await app.evaluate(
    ({ dialog }, args) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [args.projectDir] });
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: args.pdfPath });
    },
    { projectDir, pdfPath },
  );
  await page.getByRole('button', { name: 'Save project', exact: true }).click();
  await page.getByText('Saved locally', { exact: true }).waitFor();
  expect(await fs.readFile(path.join(projectDir, 'main.tex'), 'utf8')).toContain('Sam Taylor');
  await page.getByRole('button', { name: 'Export PDF', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('exported', { timeout: 10_000 });
  expect((await fs.readFile(pdfPath)).subarray(0, 5).toString()).toBe('%PDF-');
  await fs.copyFile(pdfPath, path.join(root, 'exported-resume.pdf'));
  console.log('PASS: native save/export dialogs write LaTeX files and a real PDF.');

  await page.getByRole('button', { name: 'Add source file' }).click();
  await page.getByLabel('Filename', { exact: true }).fill('sections/notes.tex');
  await page.getByRole('button', { name: 'Add file', exact: true }).click();
  await expect(page.getByRole('button', { name: 'sections/notes.tex', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'main.tex', exact: true }).last().click();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'About', exact: true }).click();
  await expect(page.getByText('Your LaTeX compiler is ready.', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Close dialog' }).click();
  await page.getByText('Up to date', { exact: true }).waitFor({ timeout: 20_000 });
  console.log('PASS: file creation and runtime settings work.');
  expect(errors, errors.join('\n')).toEqual([]);
  console.log('PASS: no renderer errors.');
  await page.getByLabel('Project name', { exact: true }).fill('Recovered workspace');
  const closed = page.waitForEvent('close');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  await closed;
  const recovery = JSON.parse(
    await fs.readFile(path.join(sandbox, 'app-data/recovery.json'), 'utf8'),
  );
  expect(recovery.project.name).toBe('Recovered workspace');
  await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
  await app.close().catch(() => {});
  app = await electron.launch({ args: [process.cwd()], env, timeout: 60_000 });
  const restored = await app.firstWindow();
  await expect(restored.getByLabel('Project name', { exact: true })).toHaveValue(
    'Recovered workspace',
  );
  await restored.getByText('Up to date', { exact: true }).waitFor({ timeout: 20_000 });
  console.log('PASS: native window close flushes recovery and reopening restores unsaved work.');
} finally {
  // The real window close path flushes recovery; avoid bypassing it in normal use.
  await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
  await app.close().catch(() => {});
}
