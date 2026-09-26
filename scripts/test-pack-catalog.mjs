import { _electron as electron, expect } from '@playwright/test';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

// Exercise the ordinary compiled application and its published HTTPS catalog.
// Only native file dialogs are controlled; keys, networking and compilers are real.
await fs.mkdir('test-results', { recursive: true });
const root = await fs.mkdtemp(path.resolve('test-results/pack-catalog-'));
const data = path.join(root, 'data');
const projectFolder = path.join(root, 'project');
await fs.mkdir(projectFolder);
const publication = JSON.parse(await fs.readFile('resources/packs/published.json', 'utf8'));
const row = publication.packs.find((p) => p.id === 'folio-multirow-2.9-v1');
expect(row).toBeTruthy();
const source = await fs.readFile('resources/packs/multirow-v1/probe.tex', 'utf8');
const env = { ...process.env, FOLIO_USER_DATA: data };
delete env.ELECTRON_RUN_AS_NODE;
delete env.FOLIO_TEST_RUNTIME_SEED;
const errors = [];
let app, page;
const launch = async () => {
  app = await electron.launch({
    ...(process.argv[2]
      ? { executablePath: path.resolve(process.argv[2]), args: [] }
      : { args: [process.cwd()] }),
    env,
    timeout: 120_000,
  });
  page = await app.firstWindow();
  page.setDefaultTimeout(30_000);
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
const choose = (filename) =>
  app.evaluate(({ dialog }, filePath) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filePath] });
  }, filename);
const settings = async () => {
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'LaTeX resources', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Reload saved packs', exact: true })).toBeEnabled();
};
const card = () => page.getByRole('article', { name: row.title, exact: true });
const savedProject = async () =>
  JSON.parse(await fs.readFile(path.join(projectFolder, 'resume.project.json'), 'utf8'));
try {
  await launch();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1480, 960));
  await choose(projectFolder);
  await page.getByRole('button', { name: 'Save project', exact: true }).click();
  await page.getByText('Saved locally', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Editor & PDF', exact: true }).click();
  await page.getByLabel('Automatic preview').uncheck();
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await page.getByRole('tab', { name: 'Code', exact: true }).click();
  await page.locator('.cm-content').click();
  await page.locator('.cm-content').press('ControlOrMeta+A');
  await page.keyboard.insertText(source);
  await page.getByRole('button', { name: 'Save project', exact: true }).click();
  await page.getByText('Saved locally', { exact: true }).waitFor();
  const original = await savedProject();
  expect(original.runtime).toEqual(row.base);
  await settings();
  await page.getByRole('button', { name: 'Check for packs', exact: true }).click();
  await expect(card()).toBeVisible();
  await expect(
    card().getByRole('button', { name: 'Download and install', exact: true }),
  ).toBeEnabled();
  await page.screenshot({ path: path.join(root, 'catalog-dark.png') });
  await card().getByRole('button', { name: 'Download and install', exact: true }).click();
  await expect(
    card().getByRole('button', { name: 'Preview for this project', exact: true }),
  ).toBeEnabled({ timeout: 180_000 });
  expect((await savedProject()).runtime).toEqual(original.runtime);
  const archivePath = path.join(
    data,
    'resource-packs/downloads',
    row.artifact.sha256,
    'payload.foliopack',
  );
  const bytes = await fs.readFile(archivePath);
  expect(bytes.length).toBe(row.artifact.bytes);
  expect(createHash('sha256').update(bytes).digest('hex')).toBe(row.artifact.sha256);
  console.log(
    'PASS: normal app downloads the published signed pack over HTTPS, installs and checks it without changing the project.',
  );

  await choose(archivePath);
  await page.getByRole('button', { name: 'Import pack file', exact: true }).click();
  const review = page.getByRole('article', { name: 'Review imported pack' });
  await expect(review).toContainText(row.title);
  await review.getByText('Package notices', { exact: true }).click();
  await expect(page.getByLabel('Imported pack notices')).toHaveValue(
    /LaTeX Project Public License/,
  );
  await expect(page.getByLabel('Imported pack notices')).toHaveValue(/SIL OPEN FONT LICENSE/);
  await page.screenshot({ path: path.join(root, 'import-review-dark.png') });
  await page.getByRole('button', { name: 'Discard import', exact: true }).click();
  await expect(review).toHaveCount(0);

  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1040, 680));
  await page.getByRole('button', { name: 'General', exact: true }).click();
  await page.getByLabel('Appearance', { exact: true }).selectOption('light');
  await page.getByRole('button', { name: 'LaTeX resources', exact: true }).click();
  await expect(
    card().getByRole('button', { name: 'Preview for this project', exact: true }),
  ).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Done', exact: true })).toBeInViewport();
  await page.screenshot({ path: path.join(root, 'installed-small-light.png') });
  await card().getByRole('button', { name: 'Preview for this project', exact: true }).click();
  await page.getByRole('button', { name: 'Build comparison', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Use this pack', exact: true })).toBeEnabled({
    timeout: 120_000,
  });
  await expect(
    page.getByText('No before PDF is available for this source.', { exact: true }),
  ).toBeVisible();
  await expect(page.locator('.compiler-comparison .textLayer')).toContainText(
    'Table resources check',
  );
  await expect(page.locator('.compiler-comparison .textLayer')).toContainText('Research');
  await page.screenshot({ path: path.join(root, 'pack-preview-light.png') });
  expect((await savedProject()).runtime).toEqual(original.runtime);
  await page.getByRole('button', { name: 'Use this pack', exact: true }).click();
  await page.getByRole('button', { name: 'Save project', exact: true }).click();
  await page.getByText('Saved locally', { exact: true }).waitFor();
  const changed = await savedProject();
  expect(changed.runtime).toEqual(row.target);
  expect(await fs.readFile(path.join(projectFolder, 'main.tex'), 'utf8')).toBe(source);
  const backups = await page.evaluate((id) => window.folio.compilerBackups(id), changed.id);
  expect(backups[0].from).toEqual(original.runtime);
  expect(backups[0].to).toEqual(row.target);
  await close();
  await launch();
  const restored = await page.evaluate(() => window.folio.bootstrap());
  expect(restored.recovered.runtime).toEqual(row.target);
  expect(restored.recovered.files.find((file) => file.path === 'main.tex').content).toBe(source);
  expect(restored.runtime.ready).toBe(true);
  await settings();
  await expect(card()).toContainText('Used by this project');
  expect(errors).toEqual([]);
  await fs.writeFile(
    path.join(root, 'result.json'),
    JSON.stringify(
      {
        passed: true,
        errors,
        artifact: row.artifact,
        before: original.runtime,
        target: row.target,
        publicCatalog: true,
        testPublisher: false,
        packaged: Boolean(process.argv[2]),
        scope:
          'Normal compiled trust, actual public HTTPS catalog/archive, native install/checks, import notices, PDF preview, explicit Apply, backup, save and restart. No provider account used.',
      },
      null,
      2,
    ) + '\n',
  );
  console.log(
    `PASS: published pack preview, notices, backup and saved compiler selection survive restart; no renderer errors.\nEvidence: ${root}`,
  );
} catch (error) {
  await page?.screenshot({ path: path.join(root, 'failure.png') }).catch(() => {});
  console.error(`Evidence: ${root}`);
  throw error;
} finally {
  await app?.evaluate(({ app }) => app.exit(0)).catch(() => {});
  await app?.close().catch(() => {});
}
