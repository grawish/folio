import { _electron as electron, expect } from '@playwright/test';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { zipSync, unzipSync, strToU8 } from 'fflate';

const root = await fs.mkdtemp(path.resolve('test-results/import-'));
const destination = path.join(root, 'imports'),
  original = path.join(root, 'original');
await fs.mkdir(destination);
await fs.mkdir(original);
const env = { ...process.env, FOLIO_USER_DATA: path.join(root, 'app-data') };
delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({
  ...(process.argv[2]
    ? { executablePath: path.resolve(process.argv[2]), args: [] }
    : { args: [process.cwd()] }),
  env,
  timeout: 60_000,
});
const errors = [];
const source = String.raw`\documentclass{article}
\begin{document}
\section*{Imported candidate}
\input{sections/details}
\end{document}`;
const zipPath = path.join(root, 'resume.zip');
await fs.writeFile(
  zipPath,
  zipSync({
    'resume/main.tex': strToU8(source.replace('Imported candidate', 'Other candidate')),
    'resume/candidate.tex': strToU8(source),
    'resume/sections/details.tex': strToU8('Relative input survived import.'),
    'resume/assets/photo.png': new Uint8Array([0, 255, 1, 2]),
    'resume/README.md': strToU8('An illustrative project readme.'),
  }),
);
try {
  const page = await app.firstWindow();
  page.setDefaultTimeout(15_000);
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (item) => {
    if (item.type() === 'error') errors.push(item.text());
  });
  await expect(page.getByLabel('Message the resume agent')).toBeEnabled({ timeout: 120_000 });
  await page.getByText('Up to date', { exact: true }).waitFor({ timeout: 60_000 });
  const action = async (label) => {
    await page.getByRole('button', { name: 'More project actions' }).click();
    await page.getByRole('menuitem', { name: label, exact: true }).click();
  };
  const choose = async (filename, parent = destination, cancelDestination = false) => {
    await app.evaluate(
      ({ dialog }, values) => {
        dialog.showOpenDialog = async (_window, options) =>
          options.properties.includes('openDirectory')
            ? {
                canceled: values.cancelDestination,
                filePaths: values.cancelDestination ? [] : [values.parent],
              }
            : { canceled: false, filePaths: [values.filename] };
      },
      { filename, parent, cancelDestination },
    );
  };
  await choose(zipPath, original);
  await page.getByRole('button', { name: 'Save project', exact: true }).click();
  await page.getByText('Saved locally', { exact: true }).waitFor();
  const oldSource = await fs.readFile(path.join(original, 'main.tex'));
  const originalMetadata = await fs.readFile(path.join(original, 'resume.project.json'));

  await page.getByLabel('Project name').fill('Keep my unsaved changes');
  await action('Import ZIP project…');
  await expect(page.getByRole('dialog')).toContainText('Keep your latest changes?');
  await page.getByRole('button', { name: 'Keep editing', exact: true }).click();
  await expect(page.getByLabel('Project name')).toHaveValue('Keep my unsaved changes');
  expect(await fs.readdir(destination)).toEqual([]);
  await page.getByLabel('Project name').fill('My resume');

  const badZip = path.join(root, 'unsafe.zip');
  await fs.writeFile(
    badZip,
    zipSync({ '../outside.tex': strToU8('do not write'), 'main.tex': strToU8(source) }),
  );
  await choose(badZip);
  await action('Import ZIP project…');
  await expect(page.getByRole('status')).toContainText('unsafe');
  await expect(page.getByRole('status')).not.toContainText('project:prepare-import');
  expect(await fs.readdir(destination)).toEqual([]);
  await expect(page.locator('.preview-pane .textLayer')).toContainText('Alex Morgan');
  console.log(
    'PASS: malformed ZIP reports a useful error and leaves the current project unchanged.',
  );

  await choose(zipPath, destination, true);
  await action('Import ZIP project…');
  await expect(page.getByRole('dialog', { name: 'Import a resume project' })).toBeVisible();
  await expect(page.getByRole('dialog').getByLabel('Main document')).toHaveValue('main.tex');
  await page.getByRole('dialog').getByLabel('Main document').selectOption('candidate.tex');
  await page.getByText('1 unsupported or hidden file will be skipped').click();
  await page.screenshot({ path: path.join(root, 'import-selection.png') });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1040, 680));
  await page.screenshot({ path: path.join(root, 'import-small.png') });
  const bounds = await page.getByRole('dialog').boundingBox();
  expect(bounds.y).toBeGreaterThanOrEqual(0);
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(680);
  await page.getByRole('button', { name: 'Choose location & import' }).click();
  await expect(page.getByRole('button', { name: 'Choose location & import' })).toBeEnabled();
  expect(await fs.readdir(destination)).toEqual([]);
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  console.log(
    'PASS: destination cancellation retains the selection; Cancel leaves no extracted files.',
  );

  await page.getByRole('button', { name: 'Switch to light mode' }).click();
  await choose(zipPath);
  await action('Import ZIP project…');
  await expect(page.getByRole('dialog', { name: 'Import a resume project' })).toBeVisible();
  await page.screenshot({ path: path.join(root, 'import-light.png') });
  await page.getByRole('dialog').getByLabel('Main document').selectOption('candidate.tex');
  await page.getByRole('button', { name: 'Choose location & import' }).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await expect(page.locator('.preview-pane .textLayer')).toContainText('Imported candidate', {
    timeout: 30_000,
  });
  await expect(page.locator('.preview-pane .textLayer')).toContainText(
    'Relative input survived import.',
  );
  await expect(page.getByRole('tab', { name: 'Chat', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  const [child] = await fs.readdir(destination),
    importedDir = path.join(destination, child);
  expect(
    (await fs.readFile(path.join(importedDir, 'assets/photo.png'))).equals(
      Buffer.from([0, 255, 1, 2]),
    ),
  ).toBe(true);
  expect((await fs.readFile(path.join(original, 'main.tex'))).equals(oldSource)).toBe(true);
  expect(
    (await fs.readFile(path.join(original, 'resume.project.json'))).equals(originalMetadata),
  ).toBe(true);
  await page.screenshot({ path: path.join(root, 'imported-workspace.png') });
  console.log(
    'PASS: selected entry compiles real relative inputs; assets survive and original files remain unchanged.',
  );

  await page.getByLabel('Message the resume agent').fill('Keep this imported draft.');
  await page.getByRole('button', { name: 'Save project', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Project saved');
  const exported = path.join(root, 'exported.zip');
  await app.evaluate(({ dialog }, filename) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: filename });
  }, exported);
  await action('Export LaTeX source…');
  await expect(page.getByRole('status')).toContainText('exported as a ZIP');
  const exportedFiles = unzipSync(await fs.readFile(exported));
  expect(Object.keys(exportedFiles)).toContain('resume.folio');
  await choose(exported);
  await action('Import ZIP project…');
  await expect(
    page.getByText(/Saved chat, PDF notes, and version history will come with it/),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Choose location & import' }).click();
  // The previous project's draft and PDF intentionally match the imported copy.
  // Wait for import completion before using those values as readiness evidence.
  await expect(page.getByRole('dialog', { name: 'Import a resume project' })).not.toBeVisible();
  await expect(page.getByLabel('Message the resume agent')).toHaveValue(
    'Keep this imported draft.',
  );
  await expect(page.locator('.preview-pane .textLayer')).toContainText('Imported candidate', {
    timeout: 30_000,
  });
  const children = await fs.readdir(destination),
    copyDir = path.join(
      destination,
      children.find((name) => name !== child),
    );
  const importedManifest = JSON.parse(
    await fs.readFile(path.join(importedDir, 'resume.project.json'), 'utf8'),
  );
  const copyManifest = JSON.parse(
    await fs.readFile(path.join(copyDir, 'resume.project.json'), 'utf8'),
  );
  expect(copyManifest.id).not.toBe(importedManifest.id);
  const copyHistory = unzipSync(await fs.readFile(path.join(copyDir, 'resume.folio')));
  expect(JSON.parse(Buffer.from(copyHistory['state.json']).toString()).projectId).toBe(
    copyManifest.id,
  );
  await page.getByRole('button', { name: 'History', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('Built from source');
  await page.getByRole('button', { name: 'Close dialog' }).click();
  console.log(
    'PASS: source ZIP round-trip retains draft and immutable PDF history with a fresh identity.',
  );

  await choose(zipPath, importedDir);
  await action('Open project folder…');
  await expect(page.getByRole('dialog', { name: 'Choose main document' })).toBeVisible();
  await expect(page.getByRole('dialog').getByLabel('Main document')).toHaveValue('candidate.tex');
  await page.getByRole('button', { name: 'Close dialog' }).click();
  await expect(page.locator('.preview-pane .textLayer')).toContainText('Imported candidate', {
    timeout: 30_000,
  });
  expect(errors, errors.join('\n')).toEqual([]);
  console.log(
    'PASS: folder open retains the selected entry and offers main-file choice. No renderer errors.',
  );
  await choose(zipPath);
  await action('Import ZIP project…');
  await app.evaluate(({ dialog }) => {
    dialog.showOpenDialog = () =>
      new Promise((resolve) => {
        globalThis.releaseImportDialog = resolve;
      });
  });
  await page.getByRole('button', { name: 'Choose location & import' }).click();
  await expect(page.getByRole('button', { name: 'Importing…' })).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Import a resume project' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Close dialog' })).toBeDisabled();
  const closed = page.waitForEvent('close');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  await app.evaluate(
    (_electron, parent) => globalThis.releaseImportDialog({ canceled: false, filePaths: [parent] }),
    destination,
  );
  await closed;
  const recovery = JSON.parse(await fs.readFile(path.join(root, 'app-data/recovery.json'), 'utf8'));
  expect(recovery.project.id).not.toBe(copyManifest.id);
  expect(recovery.directory.startsWith(destination + path.sep)).toBe(true);
  expect(
    await fs.readFile(path.join(recovery.directory, recovery.project.mainFile), 'utf8'),
  ).toContain('Other candidate');
  expect(errors, errors.join('\n')).toEqual([]);
  console.log(
    'PASS: busy import stays visible on Escape; closing waits and recovers the imported project.',
  );
  console.log(`Evidence: ${root}`);
} finally {
  await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
  await app.close().catch(() => {});
}
