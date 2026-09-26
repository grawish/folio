import { _electron as electron, expect } from '@playwright/test';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { unzipSync } from 'fflate';

await fs.mkdir('test-results', { recursive: true });
const root = await fs.mkdtemp(path.resolve('test-results/fonts-'));
const folder = path.join(root, 'project');
const copy = path.join(root, 'copy');
const selections = path.join(root, 'selections');
await Promise.all([folder, copy, selections].map((p) => fs.mkdir(p)));
const bundle = unzipSync(await fs.readFile(`resources/runtime/mac-${process.arch}/bundle.zip`));
const styles = ['regular', 'bold', 'italic', 'bold italic'];
const names = [
  'Roboto-Regular.otf',
  'Roboto-Bold.otf',
  'Roboto-Italic.otf',
  'Roboto-BoldItalic.otf',
];
for (const name of names) await fs.writeFile(path.join(selections, name), bundle[name]);
await fs.writeFile(path.join(selections, 'broken.otf'), 'This is not a font.');
const env = { ...process.env, FOLIO_USER_DATA: path.join(root, 'data') };
delete env.ELECTRON_RUN_AS_NODE;
let app, page;
const errors = [],
  checks = [];
const source = () => fs.readFile(path.join(folder, 'main.tex'), 'utf8');
const selectedFiles = async (directory = folder) =>
  (await fs.readdir(directory, { recursive: true }))
    .filter((name) => /\.(?:otf|ttf)$/.test(name))
    .sort();
const action = async (name) => {
  await page.getByRole('button', { name: 'More project actions', exact: true }).click();
  await page.getByRole('menuitem', { name, exact: true }).click();
};
const choosePath = async (file) =>
  app.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async (_window, options) => {
      globalThis.lastOpenOptions = options;
      return { canceled: !file, filePaths: file ? [file] : [] };
    };
  }, file);
const pick = async (index) => {
  await choosePath(path.join(selections, names[index]));
  await page.getByRole('button', { name: `Choose ${styles[index]} font`, exact: true }).click();
  await expect(page.locator('.font-choice').nth(index)).toContainText(names[index]);
  const options = await app.evaluate(() => globalThis.lastOpenOptions);
  expect(options.filters).toEqual([{ name: 'Font files', extensions: ['otf', 'ttf'] }]);
};
const preview = async () => {
  await page.getByRole('button', { name: 'Build font preview', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Use fonts & save', exact: true })).toBeEnabled({
    timeout: 60_000,
  });
  await expect(page.locator('.font-preview .textLayer')).toContainText('Alex Morgan');
};
const cancel = async () => {
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.locator('.font-setup')).toHaveCount(0);
};
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
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (e) => {
    if (e.type() === 'error') errors.push(e.text());
  });
  await expect(page.getByLabel('Message the resume agent')).toBeEnabled({ timeout: 120_000 });
  await page.getByText('Up to date', { exact: true }).waitFor({ timeout: 60_000 });
};
const close = async () => {
  const closed = page.waitForEvent('close');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  await closed;
  await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
  await app.close().catch(() => {});
};
try {
  await launch();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1480, 960));
  await action('Add local fonts…');
  await choosePath(folder);
  await page.getByRole('button', { name: 'Save project to continue', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Choose regular font', exact: true }),
  ).toBeEnabled();
  const original = await source();
  await choosePath(path.join(selections, 'broken.otf'));
  await page.getByRole('button', { name: 'Choose regular font', exact: true }).click();
  await expect(page.locator('.font-error')).toContainText(/font|OpenType|TrueType/i);
  await expect(
    page.getByRole('button', { name: 'Build font preview', exact: true }),
  ).toBeDisabled();
  for (let i = 0; i < styles.length; i++) await pick(i);
  await preview();
  expect(await source()).toBe(original);
  expect(await selectedFiles()).toEqual([]);
  await page.screenshot({ path: path.join(root, 'font-preview-dark.png') });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1040, 680));
  await expect.poll(() => page.evaluate(() => innerWidth)).toBe(1040);
  for (const name of ['Use fonts & save', 'Cancel']) {
    const button = page.getByRole('button', { name, exact: true });
    await expect(button).toBeInViewport();
    expect(
      await button.evaluate((node) => {
        const r = node.getBoundingClientRect();
        return node.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
      }),
    ).toBe(true);
  }
  expect(await page.locator('.font-setup').evaluate((n) => n.scrollWidth <= n.clientWidth)).toBe(
    true,
  );
  await page
    .getByRole('button', { name: 'Choose bold italic font', exact: true })
    .scrollIntoViewIfNeeded();
  await expect(
    page.getByRole('button', { name: 'Choose bold italic font', exact: true }),
  ).toBeInViewport();
  await page.screenshot({ path: path.join(root, 'font-preview-compact-dark.png') });
  await cancel();
  expect(await source()).toBe(original);
  expect(await selectedFiles()).toEqual([]);
  checks.push(
    'save-first, malformed selection, four native selection slots, real PDF preview, compact controls, cancel preserves source/assets',
  );

  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByLabel('Appearance', { exact: true }).selectOption('light');
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await action('Add local fonts…');
  await pick(0);
  await preview();
  await page.screenshot({ path: path.join(root, 'font-preview-compact-light.png') });
  // A cancelled native picker keeps the reviewed selection and preview.
  await choosePath(null);
  await page.getByRole('button', { name: 'Choose regular font', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Use fonts & save', exact: true })).toBeEnabled();
  const outside = original + '\n% Outside font-preview edit';
  await fs.writeFile(path.join(folder, 'main.tex'), outside);
  await page.getByRole('button', { name: 'Use fonts & save', exact: true }).click();
  await expect(page.locator('.font-error')).toContainText('outside Folio');
  expect(await source()).toBe(outside);
  expect(await selectedFiles()).toEqual([]);
  await cancel();
  await fs.writeFile(path.join(folder, 'main.tex'), original);
  await expect(page.getByRole('region', { name: 'External file changes' })).toHaveCount(0);
  checks.push(
    'light compact preview, cancelled picker, outside edit after preview blocks apply without overwriting',
  );

  await action('Add local fonts…');
  await pick(0);
  await preview();
  await page.reload();
  await expect(page.getByLabel('Message the resume agent')).toBeEnabled({ timeout: 120_000 });
  await page.getByText('Up to date', { exact: true }).waitFor({ timeout: 60_000 });
  expect(await source()).toBe(original);
  expect(await selectedFiles()).toEqual([]);
  checks.push('renderer reload releases preview and keeps saved project unchanged');

  await action('Add local fonts…');
  for (let i = 0; i < styles.length; i++) await pick(i);
  await preview();
  // Hold an actual journal rename, then request native close while Apply is in flight.
  await app.evaluate(
    (_, target) => {
      const fs = process.getBuiltinModule('node:fs');
      const rename = fs.promises.rename;
      fs.promises.rename = async (...args) => {
        if (args[1] === target) {
          fs.promises.rename = rename;
          globalThis.fontWriteHeld = true;
          await new Promise((resolve) => {
            globalThis.releaseFontWrite = resolve;
          });
        }
        return rename(...args);
      };
    },
    path.join(folder, 'main.tex'),
  );
  await page.getByRole('button', { name: 'Use fonts & save', exact: true }).click();
  await expect.poll(() => app.evaluate(() => globalThis.fontWriteHeld)).toBe(true);
  await expect(page.getByRole('button', { name: 'Saving…', exact: true })).toBeDisabled();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  expect(page.isClosed()).toBe(false);
  const closed = page.waitForEvent('close');
  await app.evaluate(() => globalThis.releaseFontWrite());
  await closed;
  await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
  await app.close().catch(() => {});
  const changed = await source();
  expect(changed).toContain('font-setup.tex');
  const files = await selectedFiles();
  expect(files).toHaveLength(4);
  const mapping = { regular: 0, bold: 1, italic: 2, boldItalic: 3 };
  const assetHashes = {};
  for (const file of files) {
    const bytes = await fs.readFile(path.join(folder, file));
    expect(bytes).toEqual(Buffer.from(bundle[names[mapping[path.basename(file, '.otf')]]]));
    assetHashes[file] = createHash('sha256').update(bytes).digest('hex');
  }
  checks.push(
    'native close waits for journaled apply; source and four exact font files commit together',
  );

  await launch();
  await expect(page.locator('.preview-pane .textLayer')).toContainText('Alex Morgan');
  await page.getByRole('button', { name: 'History', exact: true }).click();
  await expect(page.getByRole('navigation', { name: 'Saved versions' })).toContainText(
    'Changed local fonts',
  );
  await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await choosePath(copy);
  await action('Save project as…');
  await page.getByText('Saved locally', { exact: true }).waitFor();
  await expect.poll(() => fs.readFile(path.join(copy, 'main.tex'), 'utf8')).toBe(changed);
  for (const file of files)
    expect(await fs.readFile(path.join(copy, file))).toEqual(
      await fs.readFile(path.join(folder, file)),
    );
  const exported = path.join(root, 'source.zip');
  await app.evaluate(({ dialog }, filePath) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath });
  }, exported);
  await action('Export LaTeX source…');
  await expect(page.getByRole('status')).toContainText('exported as a ZIP');
  const zipped = unzipSync(await fs.readFile(exported));
  for (const file of files)
    expect(Buffer.from(zipped[file])).toEqual(await fs.readFile(path.join(folder, file)));
  checks.push(
    'reopen builds with saved fonts; history checkpoint exists; Save As and ZIP preserve exact font bytes',
  );
  await close();
  expect(errors, errors.join('\n')).toEqual([]);
  await fs.writeFile(
    path.join(root, 'result.json'),
    JSON.stringify({ passed: true, errors, checks, assetHashes }, null, 2),
  );
  console.log(`PASS: ${checks.join('\nPASS: ')}\nEvidence: ${root}`);
} catch (error) {
  await page?.screenshot({ path: path.join(root, 'failure.png') }).catch(() => {});
  await fs.writeFile(
    path.join(root, 'result.json'),
    JSON.stringify({ passed: false, error: error.message, errors, checks }, null, 2),
  );
  console.error(`Evidence: ${root}`);
  throw error;
} finally {
  await app?.evaluate(({ app }) => app.exit(0)).catch(() => {});
  await app?.close().catch(() => {});
}
