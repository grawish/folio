import { _electron as electron, expect } from '@playwright/test';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { unzipSync } from 'fflate';

// Native UI regression with isolated, synthetic projects. No user files/accounts.
const root = await fs.mkdtemp(path.resolve('test-results/files-'));
const directory = path.join(root, 'project'),
  copyDirectory = path.join(root, 'copy'),
  otherDirectory = path.join(root, 'other'),
  dataRoot = path.join(root, 'app-data');
for (const folder of [directory, copyDirectory, otherDirectory]) await fs.mkdir(folder);
const main = String.raw`\documentclass{article}
\begin{document}
\section*{Synthetic File Test}
A document for testing source file management.
\end{document}`;
await fs.writeFile(path.join(directory, 'main.tex'), main);
await fs.writeFile(path.join(directory, 'notes.txt'), 'Original notes');
await fs.writeFile(path.join(directory, 'details.txt'), 'Original details');
await fs.writeFile(
  path.join(otherDirectory, 'resume.tex'),
  main.replace('Synthetic File Test', 'Other Project'),
);
const env = { ...process.env, FOLIO_USER_DATA: dataRoot };
delete env.ELECTRON_RUN_AS_NODE;
let app, page;
const errors = [];
const read = (folder, name) =>
  fs.readFile(path.join(folder, name), 'utf8').catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
const trash = async (folder = directory) => JSON.parse(await read(folder, 'resume.trash')).files;
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
const action = async (label) => {
  await page.getByRole('button', { name: 'More project actions' }).click();
  await page.getByRole('menuitem', { name: label, exact: true }).click();
};
const chooseFolder = (folder) =>
  app.evaluate(({ dialog }, folder) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] });
  }, folder);
const code = () => page.getByRole('tab', { name: 'Code', exact: true }).click();
const editor = () => page.locator('.cm-content');
const select = (name) =>
  page
    .getByRole('navigation', { name: 'Project files' })
    .getByRole('button', { name, exact: true })
    .click();
const append = async (text) => {
  await editor().press('ControlOrMeta+End');
  await page.keyboard.insertText(text);
};
const manage = (name) =>
  page.getByRole('button', { name: `File actions for ${name}`, exact: true }).click();
const copies = () => action('Removed files & saved copies…');
const save = async () => {
  await page.getByRole('button', { name: 'Save project', exact: true }).click();
  await page.getByText('Saved locally', { exact: true }).waitFor();
};
const remove = async (name) => {
  await manage(name);
  await page.getByRole('button', { name: 'Remove file…', exact: true }).click();
  await page.getByRole('button', { name: 'Move to removed files', exact: true }).click();
};
try {
  await launch();
  await page.getByText('Up to date', { exact: true }).waitFor({ timeout: 60_000 });
  await chooseFolder(directory);
  await action('Open project folder…');
  await expect(page.locator('.preview-pane .textLayer')).toContainText('Synthetic File Test', {
    timeout: 60_000,
  });
  await code();
  await page.getByRole('checkbox', { name: 'Auto-compile', exact: true }).uncheck();
  await append('\n% Main edit');
  await select('notes.txt');
  await append('\nUnsaved notes');
  await select('main.tex');
  await editor().press('ControlOrMeta+z');
  await expect(editor()).not.toContainText('Main edit');
  await editor().press('ControlOrMeta+Shift+z');
  await expect(editor()).toContainText('Main edit');
  await page.getByRole('button', { name: /Switch to .* mode/ }).click();
  await page.getByRole('tab', { name: 'Chat', exact: true }).click();
  await code();
  await manage('main.tex');
  await page.getByLabel('New filename', { exact: true }).fill('notes.txt');
  await page.getByRole('button', { name: 'Rename file', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText('A file with this name already exists.');
  const longName = `sections/${'x'.repeat(160)}.tex`;
  await page.getByLabel('New filename', { exact: true }).fill(longName);
  await page.getByRole('button', { name: 'Rename file', exact: true }).click();
  await manage(longName);
  const headingFits = await page.getByRole('dialog').evaluate((dialog) => {
    const bounds = dialog.getBoundingClientRect();
    const description = dialog.querySelector('.modal-heading p').getBoundingClientRect();
    const close = dialog.querySelector('.modal-heading button').getBoundingClientRect();
    return (
      description.right <= bounds.right &&
      close.right <= bounds.right &&
      dialog.scrollWidth <= dialog.clientWidth
    );
  });
  expect(headingFits).toBe(true);
  await page.screenshot({ path: path.join(root, 'rename-long-filename.png') });
  await page.getByLabel('New filename', { exact: true }).fill('resume.tex');
  await page.getByRole('button', { name: 'Rename file', exact: true }).click();
  await expect(editor()).toHaveAttribute('aria-label', 'LaTeX source: resume.tex');
  await editor().press('ControlOrMeta+z');
  await expect(editor()).not.toContainText('Main edit');
  await editor().press('ControlOrMeta+Shift+z');
  await expect(editor()).toContainText('Main edit');
  await select('notes.txt');
  await expect(editor()).toContainText('Unsaved notes');
  await editor().press('ControlOrMeta+z');
  await expect(editor()).not.toContainText('Unsaved notes');
  await editor().press('ControlOrMeta+Shift+z');
  await expect(editor()).toContainText('Unsaved notes');
  console.log(
    'PASS: each file retains undo/redo across tabs, Chat, appearance changes and rename.',
  );

  // Remove before save so both the editor buffer and original disk bytes survive.
  await remove('notes.txt');
  await save();
  await expect.poll(() => read(directory, 'main.tex')).toBe(null);
  await expect.poll(() => read(directory, 'notes.txt')).toBe(null);
  expect(await read(directory, 'resume.tex')).toContain('% Main edit');
  expect((await trash()).map((copy) => copy.content)).toEqual(
    expect.arrayContaining([main, 'Original notes', 'Original notes\nUnsaved notes']),
  );
  expect(JSON.parse(await read(directory, 'resume.project.json')).mainFile).toBe('resume.tex');
  await manage('resume.tex');
  await page.getByRole('button', { name: 'Remove file…', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Move to removed files' })).toBeDisabled();
  await expect(page.getByRole('dialog')).toContainText('Keep at least one .tex document.');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await copies();
  await page.screenshot({ path: path.join(root, 'saved-copies.png') });
  const unsavedRow = page
    .locator('.removed-file-row')
    .filter({ hasText: 'Removed file ·' })
    .filter({ hasText: 'notes.txt' });
  await unsavedRow.getByRole('button', { name: 'Restore notes.txt', exact: true }).click();
  await expect(page.getByLabel('Saved file preview')).toContainText('Unsaved notes');
  await page.getByLabel('Restore as', { exact: true }).fill('resume.tex');
  await page.getByRole('button', { name: 'Restore file', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText('A file with this name already exists.');
  await page.getByLabel('Restore as', { exact: true }).fill('restored/notes.txt');
  await page.getByRole('button', { name: 'Restore file', exact: true }).click();
  await expect(editor()).toContainText('Unsaved notes');
  await save();
  expect(await read(directory, 'restored/notes.txt')).toBe('Original notes\nUnsaved notes');
  console.log(
    'PASS: rename/removal update disk on Save; earlier and unsaved copies restore without overwriting; last main document stays protected.',
  );

  await remove('details.txt');
  await fs.writeFile(path.join(directory, 'details.txt'), 'External details changed');
  await app.evaluate(({ dialog }) => {
    globalThis.conflictCount = 0;
    dialog.showMessageBox = async (_window, options) => {
      globalThis.conflictOptions = options;
      globalThis.conflictCount++;
      return { response: 0 };
    };
  });
  await page.getByRole('button', { name: 'Save project', exact: true }).click();
  await expect.poll(() => app.evaluate(() => globalThis.conflictCount)).toBe(1);
  expect(await read(directory, 'details.txt')).toBe('External details changed');
  expect((await app.evaluate(() => globalThis.conflictOptions)).defaultId).toBe(0);
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = async () => ({ response: 1 });
  });
  await save();
  expect(await read(directory, 'details.txt')).toBe(null);
  expect((await trash()).map((copy) => copy.content)).toEqual(
    expect.arrayContaining(['External details changed', 'Original details']),
  );
  console.log(
    'PASS: external edits stop a removal; explicit replacement preserves the outside version as a saved copy.',
  );

  await select('resume.tex');
  await append('\n% Saved copy edit');
  await chooseFolder(copyDirectory);
  await action('Save project as…');
  await page.getByText('Saved locally', { exact: true }).waitFor();
  await expect.poll(() => read(copyDirectory, 'resume.tex')).toContain('Saved copy edit');
  expect(await read(directory, 'resume.tex')).not.toContain('Saved copy edit');
  await editor().press('ControlOrMeta+z');
  await expect(editor()).not.toContainText('Saved copy edit');
  await editor().press('ControlOrMeta+Shift+z');
  await expect(editor()).toContainText('Saved copy edit');
  await copies();
  await page.getByRole('button', { name: 'Delete saved copy of main.tex', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('Delete this saved copy?');
  await page.getByRole('button', { name: 'Delete saved copy', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Restore main.tex', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Close dialog' }).click();
  await save();
  expect((await trash(copyDirectory)).some((copy) => copy.path === 'main.tex')).toBe(false);
  expect((await trash(directory)).some((copy) => copy.path === 'main.tex')).toBe(true);
  const exported = path.join(root, 'source.zip');
  await app.evaluate(({ dialog }, filePath) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath });
  }, exported);
  await action('Export LaTeX source…');
  await expect(page.getByRole('status')).toContainText('exported as a ZIP');
  const zipped = unzipSync(await fs.readFile(exported));
  expect(JSON.parse(Buffer.from(zipped['resume.trash']).toString()).files).toEqual(
    await trash(copyDirectory),
  );
  console.log(
    'PASS: Save As preserves undo and isolates saved copies; ZIP export includes the recoverable source archive.',
  );

  await remove('restored/notes.txt');
  await close();
  await launch();
  await expect(page.getByRole('status')).toContainText('last workspace has been restored', {
    timeout: 60_000,
  });
  await copies();
  await expect(
    page.getByRole('button', { name: 'Restore restored/notes.txt', exact: true }),
  ).toBeVisible();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1040, 680));
  await page.screenshot({ path: path.join(root, 'recovered-copies-small.png') });
  await page.getByRole('button', { name: 'Restore restored/notes.txt', exact: true }).click();
  await expect(page.getByLabel('Saved file preview')).toContainText('Unsaved notes');
  await page.screenshot({ path: path.join(root, 'restore-small.png') });
  await page.getByRole('button', { name: 'Restore file', exact: true }).click();
  await save();
  await select('resume.tex');
  await append('\n% prior project only');
  await save();
  await page.getByRole('button', { name: /Switch to .* mode/ }).click();
  await manage('resume.tex');
  await page.screenshot({ path: path.join(root, 'rename-small-dark.png') });
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await chooseFolder(otherDirectory);
  await action('Open project folder…');
  await code();
  await expect(editor()).toContainText('Other Project');
  await editor().press('ControlOrMeta+z');
  await expect(editor()).toContainText('Other Project');
  await expect(editor()).not.toContainText('Synthetic File Test');
  await expect(editor()).not.toContainText('prior project only');
  await action('Add source file');
  await page.getByLabel('Filename', { exact: true }).fill('sections/new.txt');
  await page.getByRole('button', { name: 'Add file', exact: true }).click();
  await expect(editor()).toContainText('% sections/new.txt');
  await save();
  expect(await read(otherDirectory, 'sections/new.txt')).toBe('% sections/new.txt\n');
  expect(errors, errors.join('\n')).toEqual([]);
  console.log(
    'PASS: restart recovers an unsaved removal; a newly opened project cannot undo into another project. No renderer errors.',
  );
  await fs.writeFile(
    path.join(root, 'result.json'),
    JSON.stringify({ passed: true, errors }, null, 2),
  );
  console.log(`Evidence: ${root}`);
} finally {
  await app?.evaluate(({ app }) => app.exit(0)).catch(() => {});
  await app?.close().catch(() => {});
}
