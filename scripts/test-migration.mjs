import { _electron as electron, expect } from '@playwright/test';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { unzipSync } from 'fflate';
import { RuntimeManager } from '../electron/core/runtime-manager.ts';
import { Compiler } from '../electron/core/compiler.ts';
import { ProjectStore } from '../electron/core/project.ts';
import { WorkspaceStore } from '../electron/core/workspace.ts';

const root = await fs.mkdtemp(path.resolve('test-results/migration-'));
const data = path.join(root, 'data'),
  folder = path.join(root, 'project');
// Optional isolated copies of already-verified test runtimes speed UI iterations.
// Default execution still prepares both runtimes from scratch.
if (process.env.FOLIO_TEST_RUNTIME_SEED) {
  await fs.mkdir(data, { recursive: true });
  await fs.cp(path.resolve(process.env.FOLIO_TEST_RUNTIME_SEED), path.join(data, 'runtimes'), {
    recursive: true,
  });
}
const oldBundle = path.join(root, 'previous-installer');
await fs.cp(path.resolve(`resources/runtime/mac-${process.arch}`), oldBundle, { recursive: true });
const manifest = JSON.parse(await fs.readFile(path.join(oldBundle, 'manifest.json'), 'utf8'));
manifest.bundle = 'folio-previous-test-bundle';
await fs.writeFile(path.join(oldBundle, 'manifest.json'), JSON.stringify(manifest));
const oldRuntime = new RuntimeManager(oldBundle, path.join(data, 'runtimes'));
await oldRuntime.initialize();
const oldStatus = await oldRuntime.status();
expect(oldStatus.ready, oldStatus.message).toBe(true);
console.log('PASS: prepared a real retained compiler identity from a previous installer fixture.');
const source =
  '\\documentclass{article}\\begin{document}\\section*{Compiler comparison resume}First page.\\newpage Second page.\\end{document}';
const project = {
  id: 'migration-resume',
  name: 'Compiler comparison resume',
  revision: 1,
  mainFile: 'main.tex',
  runtime: oldStatus.pin,
  files: [{ path: 'main.tex', content: source }],
};
const priorCompiler = new Compiler(oldRuntime, path.join(root, 'old-builds'));
const previous = await priorCompiler.compile(project);
expect(previous.status, previous.log).toBe('success');
const workspace = new WorkspaceStore(data),
  store = new ProjectStore(data);
await workspace.checkpoint(project, previous.pdf, 'Before app update');
await fs.mkdir(folder);
await fs.writeFile(path.join(folder, 'portrait.png'), Buffer.from('A preserved synthetic asset'));
await store.save(project, folder, false, (id) => workspace.archive(project.id, id));
await store.recover(await store.open(folder));
let app, page;
const errors = [];
const env = { ...process.env, FOLIO_USER_DATA: data };
delete env.ELECTRON_RUN_AS_NODE;
const launch = async () => {
  app = await electron.launch({
    ...(process.argv[2]
      ? { executablePath: path.resolve(process.argv[2]), args: [] }
      : { args: [process.cwd()] }),
    env,
    timeout: 120_000,
  });
  page = await app.firstWindow();
  page.setDefaultTimeout(15_000);
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await expect(page.getByLabel('Message the resume agent')).toBeEnabled({ timeout: 120_000 });
  await app.evaluate(({ shell }) => {
    shell.showItemInFolder = (filename) => {
      globalThis.shownBackup = filename;
    };
  });
};
const close = async () => {
  const closed = page.waitForEvent('close');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  await closed;
  await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
  await app.close().catch(() => {});
};
const settings = async () => {
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'About', exact: true }).click();
};
const compare = async () => {
  await page.getByRole('button', { name: 'Compare compilers', exact: true }).click();
  await page.getByRole('button', { name: 'Build comparison', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Use included compiler', exact: true }),
  ).toBeEnabled({ timeout: 90_000 });
  await expect(
    page
      .locator('.compiler-comparison .history-comparison section')
      .first()
      .locator('.textLayer')
      .first(),
  ).toContainText('Compiler comparison resume');
  await expect(
    page
      .locator('.compiler-comparison .history-comparison section')
      .last()
      .locator('.textLayer')
      .first(),
  ).toContainText('Compiler comparison resume');
};
try {
  await launch();
  await page.getByText('Up to date', { exact: true }).waitFor({ timeout: 60_000 });
  console.log('PASS: the project opens with its recorded compiler and tracked assets.');
  await settings();
  await compare();
  await expect(page.getByRole('heading', { name: 'Before · recorded compiler' })).toBeVisible();
  expect(
    JSON.parse(await fs.readFile(path.join(folder, 'resume.project.json'), 'utf8')).runtime,
  ).toEqual(oldStatus.pin);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1040, 680));
  await page.screenshot({ path: path.join(root, 'comparison-small-dark.png') });
  const applyBounds = await page
    .getByRole('button', { name: 'Use included compiler', exact: true })
    .boundingBox();
  expect(applyBounds.y + applyBounds.height).toBeLessThanOrEqual(680);
  await page.getByRole('button', { name: 'Show backup', exact: true }).click();
  const backupFile = await app.evaluate(() => globalThis.shownBackup);
  const archive = unzipSync(await fs.readFile(backupFile));
  expect(Buffer.from(archive['portrait.png']).toString()).toBe('A preserved synthetic asset');
  expect(Buffer.from(archive['main.tex']).toString()).toBe(source);
  expect(JSON.parse(Buffer.from(archive['resume.project.json']).toString()).runtime).toEqual(
    oldStatus.pin,
  );
  await page.getByRole('button', { name: 'Keep recorded compiler', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'About Folio', exact: true })).toBeVisible();
  await compare();
  await page.reload();
  await expect(page.getByLabel('Message the resume agent')).toBeEnabled({ timeout: 120_000 });
  await page.getByText('Up to date', { exact: true }).waitFor({ timeout: 60_000 });
  await settings();
  console.log(
    'PASS: reloading during a prepared comparison releases its lock and keeps the recorded compiler.',
  );
  await page.getByRole('button', { name: 'General', exact: true }).click();
  await page.getByLabel('Appearance', { exact: true }).selectOption('light');
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await close();
  expect(
    JSON.parse(await fs.readFile(path.join(data, 'recovery.json'), 'utf8')).project.runtime,
  ).toEqual(oldStatus.pin);
  console.log(
    'PASS: both real compilers render a comparison; Cancel preserves the pin and the full source/asset/history backup.',
  );

  await fs.rm(path.join(data, 'runtimes', oldStatus.pin.id), { recursive: true });
  await launch();
  await settings();
  await compare();
  await expect(page.getByRole('heading', { name: 'Before · saved PDF' })).toBeVisible();
  await expect(page.locator('.compiler-comparison-notice')).toContainText('may use earlier assets');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1040, 680));
  await page.screenshot({ path: path.join(root, 'saved-baseline-small-light.png') });
  const apply = page.getByRole('button', { name: 'Use included compiler', exact: true });
  const bounds = await apply.boundingBox();
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(680);
  await apply.click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByText('Up to date', { exact: true }).waitFor();
  const recovery = JSON.parse(await fs.readFile(path.join(data, 'recovery.json'), 'utf8')).project;
  const status = await page.evaluate(() => window.folio.inspectRuntime());
  expect(recovery.runtime).toEqual(status.defaultPin);
  expect(recovery.files).toEqual(project.files);
  expect(
    JSON.parse(await fs.readFile(path.join(folder, 'resume.project.json'), 'utf8')).runtime,
  ).toEqual(oldStatus.pin);
  await page.getByRole('button', { name: 'Save project', exact: true }).click();
  await page.getByText('Saved locally', { exact: true }).waitFor();
  expect(
    JSON.parse(await fs.readFile(path.join(folder, 'resume.project.json'), 'utf8')).runtime,
  ).toEqual(status.defaultPin);
  const exported = path.join(root, 'migrated.pdf');
  await app.evaluate(({ dialog }, filePath) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath });
  }, exported);
  await page.getByRole('button', { name: 'Export PDF', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('exported');
  const versions = await workspace.load(project.id);
  const latest = await workspace.version(project.id, versions.versions.at(-1).id);
  expect(await fs.readFile(exported)).toEqual(Buffer.from(latest.pdf));
  await close();
  await launch();
  await page.getByText('Up to date', { exact: true }).waitFor({ timeout: 60_000 });
  await settings();
  await expect(page.getByRole('button', { name: 'Compare compilers', exact: true })).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Compiler backups' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Show backup', exact: true })).toHaveCount(3);
  await page.screenshot({ path: path.join(root, 'backups-after-restart.png') });
  // Recreate a recovered draft using the old pin, then close while Apply is
  // held in IPC. Closing must await the committed new draft, never rewrite it
  // with the source/pin captured before the transaction.
  await close();
  const restartStore = new ProjectStore(data);
  const restored = await restartStore.loadRecovery();
  await restartStore.recover({
    ...restored,
    runtime: oldStatus.pin,
    revision: restored.revision + 1,
  });
  await launch();
  await settings();
  await compare();
  await app.evaluate(({ ipcMain }) => {
    const original = ipcMain._invokeHandlers.get('runtime:apply');
    if (!original) throw new Error('Missing migration IPC handler');
    ipcMain.removeHandler('runtime:apply');
    ipcMain.handle('runtime:apply', async (event, ...args) => {
      globalThis.migrationHeld = true;
      await new Promise((resolve) => {
        globalThis.finishMigration = resolve;
      });
      return original(event, ...args);
    });
  });
  await page.getByRole('button', { name: 'Use included compiler', exact: true }).click();
  await expect.poll(() => app.evaluate(() => globalThis.migrationHeld)).toBe(true);
  const closedDuringApply = page.waitForEvent('close');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  await expect(page.getByRole('button', { name: 'Applying…', exact: true })).toBeVisible();
  expect(page.isClosed()).toBe(false);
  await app.evaluate(() => globalThis.finishMigration());
  await closedDuringApply;
  await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
  await app.close().catch(() => {});
  const closedRecovery = JSON.parse(
    await fs.readFile(path.join(data, 'recovery.json'), 'utf8'),
  ).project;
  expect(closedRecovery.runtime).toEqual(status.defaultPin);
  expect(closedRecovery.files).toEqual(project.files);
  await launch();
  await page.getByText('Up to date', { exact: true }).waitFor({ timeout: 60_000 });
  console.log(
    'PASS: closing during Apply waits for the transaction; restart keeps the committed pin and source.',
  );
  expect(errors, errors.join('\n')).toEqual([]);
  console.log(
    'PASS: unavailable old runtime uses a labeled matching saved PDF; Apply, Save, exact PDF export and restart retain the new pin and complete backups. No renderer errors.',
  );
  await fs.writeFile(
    path.join(root, 'result.json'),
    JSON.stringify({ passed: true, errors, from: oldStatus.pin, to: status.defaultPin }, null, 2),
  );
  console.log(`Evidence: ${root}`);
} catch (error) {
  if (page) await page.screenshot({ path: path.join(root, 'failure.png') }).catch(() => {});
  console.error(`Evidence: ${root}`);
  throw error;
} finally {
  await app?.evaluate(({ app }) => app.exit(0)).catch(() => {});
  await app?.close().catch(() => {});
}
