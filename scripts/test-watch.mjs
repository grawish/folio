import { _electron as electron, expect } from '@playwright/test';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const root = await fs.mkdtemp(path.resolve('test-results/watch-'));
const directory = path.join(root, 'project'),
  copied = path.join(root, 'copy');
await fs.mkdir(directory);
await fs.mkdir(copied);
const source = String.raw`\documentclass{article}
\begin{document}
\section*{Baseline Candidate}
Synthetic external edit test.
\end{document}`;
await fs.writeFile(path.join(directory, 'main.tex'), source);
await fs.writeFile(path.join(directory, 'notes.txt'), 'Initial notes');
await fs.writeFile(path.join(directory, 'photo.png'), Buffer.from([0, 1, 2]));
const env = { ...process.env, FOLIO_USER_DATA: path.join(root, 'app-data') };
delete env.ELECTRON_RUN_AS_NODE;
const errors = [];
let app, page;
const launch = async () => {
  app = await electron.launch({
    ...(process.argv[2]
      ? { executablePath: path.resolve(process.argv[2]), args: [] }
      : { args: [process.cwd()] }),
    env,
    timeout: 60_000,
  });
  page = await app.firstWindow();
  page.setDefaultTimeout(15_000);
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (item) => {
    if (item.type() === 'error') errors.push(item.text());
  });
  await expect(page.getByLabel('Message the resume agent')).toBeEnabled({ timeout: 120_000 });
};
const close = async () => {
  const closed = page.waitForEvent('close');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  await closed;
  await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
  await app.close().catch(() => {});
};
const choose = (folder) =>
  app.evaluate(({ dialog }, folder) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] });
  }, folder);
const action = async (name) => {
  await page.getByRole('button', { name: 'More project actions' }).click();
  await page.getByRole('menuitem', { name, exact: true }).click();
};
const code = () => page.getByRole('tab', { name: 'Code', exact: true }).click();
const editor = () => page.locator('.cm-content');
const notice = () => page.getByRole('region', { name: 'External file changes' });
const review = () => page.getByRole('button', { name: 'Review changes', exact: true }).click();
const save = async () => {
  await page.getByRole('button', { name: 'Save project', exact: true }).click();
  await page.getByText('Saved locally', { exact: true }).waitFor();
};
try {
  await launch();
  await page.getByText('Up to date', { exact: true }).waitFor({ timeout: 60_000 });
  await choose(directory);
  await action('Open project folder…');
  await expect(page.locator('.preview-pane .textLayer')).toContainText('Baseline Candidate', {
    timeout: 60_000,
  });
  await code();
  await page.getByRole('checkbox', { name: 'Auto-compile', exact: true }).uncheck();
  await editor().fill(source.replace('Baseline Candidate', 'Editor Candidate'));
  await page
    .getByRole('navigation', { name: 'Project files' })
    .getByRole('button', { name: 'notes.txt', exact: true })
    .click();
  await editor().fill('Unsaved editor notes');
  await fs.writeFile(
    path.join(directory, '.atomic-edit'),
    source.replace('Baseline Candidate', 'Disk Candidate'),
  );
  await fs.rename(path.join(directory, '.atomic-edit'), path.join(directory, 'main.tex'));
  await fs.unlink(path.join(directory, 'notes.txt'));
  await fs.mkdir(path.join(directory, 'sections'));
  await fs.writeFile(path.join(directory, 'sections/new.txt'), 'New disk section');
  await expect(notice()).toContainText('3 files changed');
  await expect(editor()).toHaveText('Unsaved editor notes');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button', { name: 'Compile', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Files changed outside Folio' })).toBeVisible();
  await expect(page.getByLabel('Changed files')).toContainText('sections/new.txt');
  await page.screenshot({ path: path.join(root, 'review-dark.png') });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1040, 680));
  await page.screenshot({ path: path.join(root, 'review-small-dark.png') });
  const button = await page
    .getByRole('button', { name: 'Reload source from disk', exact: true })
    .boundingBox();
  expect(button.y + button.height).toBeLessThanOrEqual(680);
  await page.getByRole('button', { name: 'Keep editing', exact: true }).click();
  await app.evaluate(({ dialog }) => {
    globalThis.conflicts = 0;
    dialog.showMessageBox = async () => {
      globalThis.conflicts++;
      return { response: 0 };
    };
  });
  await page.getByRole('button', { name: 'Save project', exact: true }).click();
  await expect.poll(() => app.evaluate(() => globalThis.conflicts)).toBe(1);
  expect(await fs.readFile(path.join(directory, 'main.tex'), 'utf8')).toContain('Disk Candidate');
  await review();
  await fs.writeFile(
    path.join(directory, 'main.tex'),
    source.replace('Baseline Candidate', 'Disk Revised'),
  );
  await page.getByRole('button', { name: 'Check again', exact: true }).click();
  await page.getByRole('button', { name: 'Reload source from disk', exact: true }).click();
  await expect(notice()).toHaveCount(0);
  await expect(editor()).toContainText('Disk Revised');
  await action('Removed files & saved copies…');
  await page.getByRole('button', { name: 'Restore notes.txt', exact: true }).click();
  await expect(page.getByLabel('Saved file preview')).toHaveText('Unsaved editor notes');
  await page.getByRole('button', { name: 'Close dialog' }).click();
  await page.getByRole('button', { name: 'Compile', exact: true }).click();
  await expect(page.locator('.preview-pane .textLayer')).toContainText('Disk Revised', {
    timeout: 60_000,
  });
  await save();
  await expect(notice()).toHaveCount(0);
  const copies = JSON.parse(await fs.readFile(path.join(directory, 'resume.trash'), 'utf8')).files;
  expect(copies.some((copy) => copy.content.includes('Editor Candidate'))).toBe(true);
  expect(copies.some((copy) => copy.content === 'Unsaved editor notes')).toBe(true);
  console.log(
    'PASS: nested added/deleted/atomic edits are detected; review preserves buffers, compile waits, reload and save retain editor copies.',
  );

  await fs.writeFile(
    path.join(directory, 'main.tex'),
    source.replace('Baseline Candidate', 'External Replacement'),
  );
  await expect(notice()).toBeVisible();
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = async () => ({ response: 1 });
  });
  await save();
  await expect(notice()).toHaveCount(0);
  const replaced = JSON.parse(
    await fs.readFile(path.join(directory, 'resume.trash'), 'utf8'),
  ).files;
  expect(replaced.some((copy) => copy.content.includes('External Replacement'))).toBe(true);
  expect(await fs.readFile(path.join(directory, 'main.tex'), 'utf8')).toContain('Disk Revised');

  await fs.writeFile(path.join(directory, 'photo.png'), Buffer.from([2, 1, 0]));
  await expect(notice()).toContainText('1 file changed');
  await expect(page.locator('.stale-note')).toBeVisible();
  await page.getByRole('button', { name: 'Export PDF', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('photo.png');
  await page.getByRole('button', { name: 'Keep editing', exact: true }).click();
  await page.getByRole('button', { name: /Switch to .* mode/ }).click();
  await review();
  await page.screenshot({ path: path.join(root, 'review-small-light.png') });
  await page.getByRole('button', { name: 'Reload source from disk', exact: true }).click();
  await expect(notice()).toHaveCount(0);
  await expect(page.locator('.stale-note')).toBeVisible();
  const accepted = JSON.parse(
    await fs.readFile(path.join(root, 'app-data', 'recovery.json'), 'utf8'),
  ).project;
  const staleExport = await page.evaluate(async (project) => {
    try {
      await window.folio.exportPdf(project);
      return '';
    } catch (error) {
      return error.message;
    }
  }, accepted);
  expect(staleExport).toContain('Compile the current source successfully');
  await page.getByRole('button', { name: 'Compile', exact: true }).click();
  await page.getByText('Up to date', { exact: true }).waitFor({ timeout: 60_000 });
  await save();
  console.log(
    'PASS: explicit replacement retains outside text; asset-only changes mark the PDF stale and block export until reviewed.',
  );

  await fs.unlink(path.join(directory, 'main.tex'));
  await expect(notice()).toBeVisible();
  await review();
  await expect(page.getByRole('dialog')).toContainText('No .tex document remains on disk');
  await expect(
    page.getByRole('button', { name: 'Reload source from disk', exact: true }),
  ).toBeDisabled();
  await choose(copied);
  await page.getByRole('button', { name: 'Save a copy…', exact: true }).click();
  await page.getByText('Saved locally', { exact: true }).waitFor();
  await expect(notice()).toHaveCount(0);
  expect(await fs.readFile(path.join(copied, 'main.tex'), 'utf8')).toContain('Disk Revised');
  await expect
    .poll(() =>
      fs.access(path.join(directory, 'main.tex')).then(
        () => true,
        () => false,
      ),
    )
    .toBe(false);
  await fs.writeFile(
    path.join(directory, 'main.tex'),
    source.replace('Baseline Candidate', 'Former Project'),
  );
  await page.waitForTimeout(650);
  await expect(notice()).toHaveCount(0);
  await close();
  await fs.writeFile(
    path.join(copied, 'main.tex'),
    source.replace('Baseline Candidate', 'Changed While Closed'),
  );
  await launch();
  await expect(notice()).toBeVisible({ timeout: 60_000 });
  await code();
  await expect(editor()).toContainText('Disk Revised');
  await review();
  await page.getByRole('button', { name: 'Reload source from disk', exact: true }).click();
  await expect(editor()).toContainText('Changed While Closed');
  await save();
  console.log(
    'PASS: missing main is protected, Save As preserves the original folder, watcher follows the new project and restart detects outside edits.',
  );

  const manifestPath = path.join(copied, 'resume.project.json');
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  await fs.writeFile(manifestPath, JSON.stringify({ ...manifest, name: 'Outside project name' }));
  await expect(notice()).toBeVisible();
  await review();
  await expect(page.getByRole('dialog')).toContainText('resume.project.json');
  await expect(
    page.getByRole('button', { name: 'Reload source from disk', exact: true }),
  ).toBeDisabled();
  await page.getByRole('button', { name: 'Keep editing', exact: true }).click();
  expect(JSON.parse(await fs.readFile(manifestPath, 'utf8')).name).toBe('Outside project name');
  expect(errors, errors.join('\n')).toEqual([]);
  await fs.writeFile(
    path.join(root, 'result.json'),
    JSON.stringify({ passed: true, errors }, null, 2),
  );
  console.log(
    'PASS: changed project data stays visible and is never silently acknowledged. No renderer errors.',
  );
  console.log(`Evidence: ${root}`);
} finally {
  await app?.evaluate(({ app }) => app.exit(0)).catch(() => {});
  await app?.close().catch(() => {});
}
