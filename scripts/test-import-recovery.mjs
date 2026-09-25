import { _electron as electron, expect } from '@playwright/test';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { zipSync } from 'fflate';
import { ImportTransactions } from '../electron/core/import-transactions.ts';

const root = await fs.mkdtemp(path.resolve('test-results/import-recovery-'));
const data = path.join(root, 'data');
const parent = path.join(root, 'imports');
const trash = path.join(root, 'test-trash');
await fs.mkdir(parent);
await fs.mkdir(trash);
const recovery = new ImportTransactions(data);
const archives = [];
const errors = [];
const env = { ...process.env, FOLIO_USER_DATA: data };
delete env.ELECTRON_RUN_AS_NODE;
if (process.env.FOLIO_TEST_RUNTIME_SEED) {
  await fs.mkdir(data, { recursive: true });
  await fs.cp(path.resolve(process.env.FOLIO_TEST_RUNTIME_SEED), path.join(data, 'runtimes'), {
    recursive: true,
  });
}

async function interrupted(name, boundary) {
  const source =
    '\\documentclass{article}\n\\begin{document}\n\\section*{' +
    name +
    '}\n\\input{sections/details}\n\\end{document}';
  const files = new Map([
    ['main.tex', Buffer.from(source)],
    ['sections/details.tex', Buffer.from('Recovered relative input.')],
    ['assets/image.png', Buffer.from([0, 255, 20, 4])],
    [
      'resume.project.json',
      Buffer.from(JSON.stringify({ schemaVersion: 2, name, mainFile: 'main.tex' })),
    ],
  ]);
  const filename = path.join(root, name.replaceAll(' ', '-') + '.zip');
  const bytes = Buffer.from(zipSync(Object.fromEntries(files)));
  await fs.writeFile(filename, bytes);
  archives.push({ filename, bytes });
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', 'tests/fixtures/import-crash.ts', data, parent, filename, boundary],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let stdout = '',
    stderr = '';
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
    if (stdout.includes('READY-TO-KILL')) child.kill('SIGKILL');
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('Import crash fixture timed out: ' + stderr));
    }, 20_000);
    child.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on('close', (_code, signal) => {
      clearTimeout(timeout);
      if (signal === 'SIGKILL' && stdout.includes('READY-TO-KILL')) resolve();
      else reject(new Error('Crash fixture exited unexpectedly: ' + stderr));
    });
  });
  const item = (await recovery.list()).find((item) => item.name === name);
  expect(item).toBeTruthy();
  return { ...item, files };
}

const finishCopy = await interrupted('Finish me', 'file');
const completeCopy = await interrupted('Open me', 'complete');
const trashCopy = await interrupted('Trash me', 'partial');
const editedCopy = await interrupted('Keep my edit', 'file');
const preparingCopy = await interrupted('Preparing copy', 'staging');
const completedManifest = await fs.readFile(
  path.join(completeCopy.directory, 'resume.project.json'),
);
await fs.writeFile(path.join(editedCopy.directory, 'main.tex'), 'Outside edits must remain.');

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
  page.setDefaultTimeout(20_000);
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (item) => {
    if (item.type() === 'error') errors.push(item.text());
  });
  await expect(page.getByLabel('Message the resume agent')).toBeEnabled({ timeout: 120_000 });
  await expect(page.getByText('Up to date', { exact: true })).toBeVisible({ timeout: 60_000 });
  await app.evaluate(
    ({ shell }, values) => {
      globalThis.importTrashCalls = [];
      globalThis.importRevealCalls = [];
      shell.showItemInFolder = (filename) => globalThis.importRevealCalls.push(filename);
      shell.trashItem = async (directory) => {
        const path = process.getBuiltinModule('node:path');
        if (path.dirname(directory) !== values.parent)
          throw new Error('Only synthetic test imports may be moved.');
        await process
          .getBuiltinModule('node:fs')
          .promises.rename(directory, path.join(values.trash, path.basename(directory)));
        globalThis.importTrashCalls.push(directory);
      };
    },
    { parent, trash },
  );
};
const stop = async () => {
  if (!app) return;
  await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
  await app.close().catch(() => {});
  app = undefined;
};
const closeNormally = async () => {
  const closed = page.waitForEvent('close');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  await closed;
  await stop();
};
const review = async () => {
  await page.getByRole('button', { name: 'Review interrupted imports', exact: true }).click();
  await expect(
    page.getByRole('dialog', { name: 'Interrupted imports', exact: true }),
  ).toBeVisible();
  await expect(page.getByText('Checking saved imports…', { exact: true })).not.toBeVisible();
};
const row = (name) => page.getByRole('region', { name, exact: true });
const restored = async (item, acknowledged = true) => {
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await expect(page.getByLabel('Project name')).toHaveValue(item.name);
  await expect(page.locator('.preview-pane .textLayer')).toContainText(item.name, {
    timeout: 45_000,
  });
  await expect(page.locator('.preview-pane .textLayer')).toContainText('Recovered relative input.');
  await expect
    .poll(async () => (await recovery.list()).some((entry) => entry.id === item.id))
    .toBe(!acknowledged);
  for (const [name, bytes] of item.files)
    if (name !== 'resume.project.json')
      expect((await fs.readFile(path.join(item.directory, name))).equals(bytes)).toBe(true);
};

try {
  await launch();
  await expect(page.getByRole('tab', { name: 'Chat', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await page.getByLabel('Project name').fill('Keep this unfinished draft');
  await review();
  await expect(page.getByRole('dialog')).not.toContainText('Keep your latest changes?');
  await expect(page.getByRole('dialog').getByRole('region')).toHaveCount(5);
  await expect(
    row('Preparing copy').getByRole('button', { name: 'Show folder', exact: true }),
  ).toHaveCount(0);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1040, 680));
  await page.screenshot({ path: path.join(root, 'recovery-dark-small.png') });
  const bounds = await page.getByRole('dialog').boundingBox();
  const footer = await page.getByRole('button', { name: 'Done', exact: true }).boundingBox();
  expect(bounds.y).toBeGreaterThanOrEqual(0);
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(680);
  expect(footer.y + footer.height).toBeLessThanOrEqual(680);
  expect(
    await page
      .locator('.import-recovery-body')
      .evaluate((node) => node.scrollHeight > node.clientHeight),
  ).toBe(true);
  await row('Finish me').getByRole('button', { name: 'Finish import', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('Keep your latest changes?');
  await page.getByRole('button', { name: 'Keep editing', exact: true }).click();
  await expect(page.getByLabel('Project name')).toHaveValue('Keep this unfinished draft');
  expect((await recovery.list()).length).toBe(5);
  await review();
  await row('Finish me').getByRole('button', { name: 'Finish import', exact: true }).click();
  await page.getByRole('button', { name: 'Discard changes', exact: true }).click();
  await restored(finishCopy);
  await page.screenshot({ path: path.join(root, 'recovered-workspace.png') });
  console.log(
    'PASS: recovery review preserves the current draft; explicit resume uses the unsaved guard, compiles all inputs and acknowledges the exact copy.',
  );

  await app.evaluate(({ ipcMain }) => {
    const original = ipcMain._invokeHandlers.get('project:acknowledge-import');
    ipcMain._invokeHandlers.set('project:acknowledge-import', async () => {
      ipcMain._invokeHandlers.set('project:acknowledge-import', original);
      throw new Error('Injected recovery-record cleanup failure');
    });
  });
  await review();
  await row('Open me').getByRole('button', { name: 'Open recovered project', exact: true }).click();
  await restored(completeCopy, false);
  await review();
  await row('Open me').getByRole('button', { name: 'Move copy to Trash', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('This imported project is open');
  expect((await recovery.list()).find((item) => item.id === completeCopy.id).state).toBe(
    'complete',
  );
  expect(await app.evaluate(() => globalThis.importTrashCalls)).toEqual([]);
  await row('Open me').getByRole('button', { name: 'Open recovered project', exact: true }).click();
  await restored(completeCopy);
  expect(
    (await fs.readFile(path.join(completeCopy.directory, 'resume.project.json'))).equals(
      completedManifest,
    ),
  ).toBe(true);
  expect((await fs.readdir(parent)).length).toBe(4);
  await page.getByRole('button', { name: 'Switch to light mode', exact: true }).click();
  await review();
  await expect(row('Keep my edit')).toContainText('changed outside Folio');
  await expect(
    row('Keep my edit').getByRole('button', { name: 'Finish import', exact: true }),
  ).toHaveCount(0);
  await expect(
    row('Keep my edit').getByRole('button', { name: 'Move copy to Trash', exact: true }),
  ).toHaveCount(0);
  await row('Keep my edit').getByRole('button', { name: 'Show folder', exact: true }).click();
  expect(await app.evaluate(() => globalThis.importRevealCalls)).toEqual([editedCopy.directory]);
  await row('Keep my edit')
    .getByRole('button', { name: 'Keep files & dismiss…', exact: true })
    .click();
  await row('Keep my edit')
    .getByRole('button', { name: 'Keep files & stop recovery', exact: true })
    .scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(root, 'outside-edit-light-small.png') });
  await row('Keep my edit')
    .getByRole('button', { name: 'Keep files & stop recovery', exact: true })
    .click();
  await expect(row('Keep my edit')).toHaveCount(0);
  expect(await fs.readFile(path.join(editedCopy.directory, 'main.tex'), 'utf8')).toBe(
    'Outside edits must remain.',
  );
  console.log(
    'PASS: completed imports reopen the same project; outside edits prevent resume/removal and explicit dismissal preserves their bytes.',
  );

  await row('Trash me').getByRole('button', { name: 'Move copy to Trash', exact: true }).click();
  await expect(row('Trash me')).toHaveCount(0);
  expect(await app.evaluate(() => globalThis.importTrashCalls)).toEqual([trashCopy.directory]);
  expect(
    await fs.readFile(path.join(trash, path.basename(trashCopy.directory), 'main.tex'), 'utf8'),
  ).toBe(
    trashCopy.files
      .get('main.tex')
      .toString()
      .slice(0, Math.floor(trashCopy.files.get('main.tex').length / 2)),
  );
  await row('Preparing copy')
    .getByRole('button', { name: 'Discard recovery copy', exact: true })
    .click();
  await expect(page.getByText('No interrupted imports to review.', { exact: true })).toBeVisible();
  expect(await app.evaluate(() => globalThis.importTrashCalls)).toHaveLength(1);
  expect(await fs.stat(preparingCopy.directory).catch((error) => error.code)).toBe('ENOENT');
  expect(await recovery.count()).toBe(0);
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Review interrupted imports', exact: true }),
  ).toHaveCount(0);
  await page.getByRole('button', { name: 'More project actions', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Interrupted imports…', exact: true }).click();
  await expect(page.getByText('No interrupted imports to review.', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.screenshot({ path: path.join(root, 'settings-light-small.png') });
  await page.getByRole('button', { name: 'Review imports', exact: true }).click();
  await expect(page.getByText('No interrupted imports to review.', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await closeNormally();
  console.log(
    'PASS: verified partial copies go through native Trash; unfinished preparation only removes staging. Header, project menu and Settings stay consistent.',
  );

  await launch();
  await expect(page.getByLabel('Project name')).toHaveValue('Open me');
  await expect(
    page.getByRole('button', { name: 'Review interrupted imports', exact: true }),
  ).toHaveCount(0);
  await closeNormally();
  const closingCopy = await interrupted('Closing import', 'file');
  await launch();
  await app.evaluate(({ ipcMain }) => {
    const original = ipcMain._invokeHandlers.get('project:resume-import');
    ipcMain._invokeHandlers.set('project:resume-import', async (...args) => {
      ipcMain._invokeHandlers.set('project:resume-import', original);
      const project = await original(...args);
      return new Promise((resolve) => {
        globalThis.releaseImportRecovery = () => resolve(project);
      });
    });
  });
  await review();
  await row('Closing import').getByRole('button', { name: 'Finish import', exact: true }).click();
  await expect
    .poll(() => app.evaluate(() => typeof globalThis.releaseImportRecovery))
    .toBe('function');
  await expect(page.getByText('Updating the import…', { exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(
    page.getByRole('dialog', { name: 'Interrupted imports', exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Close dialog', exact: true })).toBeDisabled();
  const closed = page.waitForEvent('close');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  expect(page.isClosed()).toBe(false);
  expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1);
  await app.evaluate(() => globalThis.releaseImportRecovery());
  await closed;
  await stop();
  const savedRecovery = JSON.parse(await fs.readFile(path.join(data, 'recovery.json'), 'utf8'));
  expect(savedRecovery.project.name).toBe('Closing import');
  expect(savedRecovery.directory).toBe(closingCopy.directory);
  expect(await recovery.count()).toBe(0);
  await launch();
  await expect(page.getByLabel('Project name')).toHaveValue('Closing import');
  await expect(page.locator('.preview-pane .textLayer')).toContainText('Closing import');
  await expect(
    page.getByRole('button', { name: 'Review interrupted imports', exact: true }),
  ).toHaveCount(0);
  await closeNormally();
  for (const archive of archives)
    expect((await fs.readFile(archive.filename)).equals(archive.bytes)).toBe(true);
  expect(errors, errors.join('\n')).toEqual([]);
  console.log(
    'PASS: close waits for recovery; restart opens the recovered project with no leftover import record. All original ZIPs preserved; no renderer errors.',
  );
  await fs.writeFile(
    path.join(root, 'result.json'),
    JSON.stringify(
      {
        passed: true,
        crashes: 6,
        originalArchivesPreserved: archives.length,
        rendererErrors: errors,
        nativeTrashIntercepted: true,
        minimumWindow: [1040, 680],
      },
      null,
      2,
    ) + '\n',
  );
  console.log('Evidence: ' + root);
} catch (error) {
  if (page && !page.isClosed())
    await page.screenshot({ path: path.join(root, 'failure.png') }).catch(() => {});
  console.error('Failure evidence: ' + root);
  throw error;
} finally {
  await stop();
}
