import { _electron as electron, expect } from '@playwright/test';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { unzipSync } from 'fflate';
import { createHash, randomUUID } from 'node:crypto';
import { tsImport } from 'tsx/esm/api';

const root = await fs.mkdtemp(path.resolve('test-results/runtime-'));
const data = path.join(root, 'data'),
  folder = path.join(root, 'project');
await fs.mkdir(folder);
const env = { ...process.env, FOLIO_USER_DATA: data };
delete env.ELECTRON_RUN_AS_NODE;
let app, page;
const errors = [];
const launch = async (waitUntilReady = true) => {
  app = await electron.launch({
    ...(process.argv[2]
      ? { executablePath: path.resolve(process.argv[2]), args: [] }
      : { args: [process.cwd()] }),
    env,
    timeout: 120_000,
  });
  page = await app.firstWindow();
  page.setDefaultTimeout(20_000);
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (item) => {
    if (item.type() === 'error') errors.push(item.text());
  });
  await page.locator('.app-shell').waitFor();
  if (waitUntilReady)
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
const settings = async () => {
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'About', exact: true }).click();
};
try {
  await fs.mkdir(data, { recursive: true });
  const startupRecovery = JSON.stringify({
    project: {
      id: 'startup-recovery',
      name: 'Recovered resume',
      revision: 3,
      mainFile: 'main.tex',
      files: [
        {
          path: 'main.tex',
          content:
            '\\documentclass{article}\\begin{document}Keep my recovered resume.\\end{document}',
        },
      ],
    },
  });
  await fs.writeFile(path.join(data, 'recovery.json'), startupRecovery);
  const earlyStarted = Date.now();
  await launch(false);
  await expect(page.getByLabel('Message the resume agent')).toBeEnabled({ timeout: 10_000 });
  const editingReadyMs = Date.now() - earlyStarted;
  await expect(page.getByLabel('Project name')).toHaveValue('Recovered resume');
  await expect(page.locator('.compiler-preparation')).toBeVisible();
  await expect(page.locator('.app-shell')).not.toHaveAttribute('inert', '');
  const early = await page.evaluate(() => window.folio.bootstrap());
  expect(early.runtime.ready).toBe(false);
  expect(early.runtime.preparing).toBe(true);
  expect(early.runtime.pin.id).toMatch(/^[a-f0-9]{64}$/);
  const earlyDraft = 'Please keep this draft while the local compiler prepares.';
  await page.getByLabel('Message the resume agent').fill(earlyDraft);
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeDisabled();
  await page.getByRole('tab', { name: 'Code', exact: true }).click();
  await expect(page.locator('.cm-content')).toContainText('Keep my recovered resume.');
  await page.locator('.cm-content').press('ControlOrMeta+End');
  await page.keyboard.insertText('\n% Edited while the compiler prepared');
  await expect(page.getByRole('button', { name: 'Compile', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Export PDF', exact: true })).toBeDisabled();
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].webContents.send('menu', 'compile');
  });
  await choose(folder);
  await page.getByRole('button', { name: 'Save project', exact: true }).click();
  await page.getByText('Saved locally', { exact: true }).waitFor();
  expect(
    JSON.parse(await fs.readFile(path.join(folder, 'resume.project.json'), 'utf8')).runtime,
  ).toEqual(early.runtime.pin);
  await expect(page.locator('.compiler-preparation')).toBeVisible();
  await expect(
    fs.access(path.join(data, 'runtimes', early.runtime.pin.id, 'active.json')),
  ).rejects.toThrow();
  await page.screenshot({ path: path.join(root, 'startup-editing.png') });
  await page.getByRole('tab', { name: 'Chat', exact: true }).click();
  await page.screenshot({ path: path.join(root, 'startup-chat.png') });
  await close();
  const earlyRecovered = JSON.parse(await fs.readFile(path.join(data, 'recovery.json'), 'utf8'));
  expect(earlyRecovered.project.files[0].content).toContain('Edited while the compiler prepared');
  expect(earlyRecovered.project.runtime).toEqual(early.runtime.pin);
  console.log(
    `PASS: recovered editing ready in ${editingReadyMs} ms; source, chat draft and exact compiler pin can be saved before preparation finishes.`,
  );
  const started = Date.now();
  await launch();
  await expect(page.getByLabel('Project name')).toHaveValue('Recovered resume');
  await expect(page.getByLabel('Message the resume agent')).toHaveValue(earlyDraft);
  await page.getByText('Up to date', { exact: true }).waitFor({ timeout: 120_000 });
  const status = await page.evaluate(() => window.folio.inspectRuntime());
  expect(status.ready, status.message).toBe(true);
  expect(status.pin.id).toMatch(/^[a-f0-9]{64}$/);
  await choose(folder);
  await page.getByRole('button', { name: 'Save project', exact: true }).click();
  await page.getByText('Saved locally', { exact: true }).waitFor();
  const manifestPath = path.join(folder, 'resume.project.json');
  const original = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  expect(original.runtime).toEqual(status.pin);
  const pointerFile = path.join(data, 'runtimes', status.pin.id, 'active.json');
  const pointer = JSON.parse(await fs.readFile(pointerFile, 'utf8'));
  console.log(
    `PASS: first launch prepares a verified local compiler and saves its exact pin (${Date.now() - started} ms through first save).`,
  );

  await page.getByRole('tab', { name: 'Code', exact: true }).click();
  await page.getByLabel('Auto-compile', { exact: true }).uncheck();
  await fs.writeFile(
    path.join(data, 'runtimes', status.pin.id, 'copies', pointer.generation, 'runtime/bundle.zip'),
    'Damaged local test copy',
  );
  await page.locator('.cm-content').press('ControlOrMeta+End');
  await page.keyboard.insertText('\n% Retain this edit during compiler repair');
  await page.getByRole('button', { name: 'Compile', exact: true }).click();
  await page
    .getByRole('button', { name: 'Compiler needs attention', exact: true })
    .waitFor({ timeout: 60_000 });
  await page.getByRole('button', { name: 'Compiler needs attention', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'About Folio', exact: true })).toBeVisible();
  await expect(page.locator('.runtime-details')).toContainText('integrity check');
  await expect(page.locator('.runtime-details')).toHaveClass(/runtime-unavailable/);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1040, 680));
  await page.screenshot({ path: path.join(root, 'repair-needed-small-dark.png') });
  await page.getByRole('button', { name: 'Repair compiler', exact: true }).click();
  await page.getByRole('button', { name: 'Repairing…', exact: true }).waitFor();
  await page.screenshot({ path: path.join(root, 'repair-working.png') });
  await expect(page.locator('.runtime-details')).toContainText('compiler is ready', {
    timeout: 120_000,
  });
  await expect(page.getByRole('button', { name: 'Repair compiler', exact: true })).toBeEnabled();
  await expect(page.locator('.runtime-details')).not.toHaveClass(/runtime-unavailable/);
  const repairedPointer = JSON.parse(await fs.readFile(pointerFile, 'utf8'));
  expect(repairedPointer.generation).not.toBe(pointer.generation);
  expect(JSON.parse(await fs.readFile(manifestPath, 'utf8')).runtime).toEqual(status.pin);
  await page.getByRole('button', { name: 'General', exact: true }).click();
  await page.getByLabel('Appearance', { exact: true }).selectOption('light');
  await page.getByRole('button', { name: 'About', exact: true }).click();
  const repair = page.getByRole('button', { name: 'Repair compiler', exact: true });
  await repair.scrollIntoViewIfNeeded();
  const bounds = await repair.boundingBox();
  expect(bounds.y + bounds.height).toBeLessThan(680);
  await page.screenshot({ path: path.join(root, 'repaired-small-light.png') });
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(page.locator('.cm-content')).toContainText('Retain this edit');
  await page.getByRole('button', { name: 'Compile', exact: true }).click();
  await page.getByText('Up to date', { exact: true }).waitFor({ timeout: 60_000 });
  await page.getByRole('button', { name: 'Save project', exact: true }).click();
  await page.getByText('Saved locally', { exact: true }).waitFor();
  const workspace = await page.evaluate((id) => window.folio.loadWorkspace(id), original.id);
  const version = await page.evaluate(({ id, version }) => window.folio.readVersion(id, version), {
    id: original.id,
    version: workspace.versions.at(-1).id,
  });
  expect(version.runtime).toEqual(status.pin);
  console.log(
    'PASS: damaged compiler blocks builds; Settings repairs it offline, keeps source and pin, and rebuilds a real PDF.',
  );

  // A tiny, inert old compiler lives only in this disposable profile. The
  // current compiler continues to be the real packaged engine used above.
  const { runtimePin } = await tsImport('../electron/core/runtime.ts', import.meta.url);
  const oldManifest = {
    schemaVersion: 1,
    version: '0.16.0',
    bundle: 'storage-demo',
    platform: 'darwin-arm64',
    files: {
      tectonic: createHash('sha256').update('Inert test engine').digest('hex'),
      'bundle.zip': createHash('sha256').update('Inert test resources').digest('hex'),
    },
  };
  const oldPin = runtimePin(oldManifest),
    oldGeneration = randomUUID();
  const oldRoot = path.join(data, 'runtimes', oldPin.id),
    oldCopy = path.join(oldRoot, 'copies', oldGeneration);
  await fs.mkdir(path.join(oldCopy, 'runtime'), { recursive: true });
  await fs.writeFile(path.join(oldCopy, 'runtime/tectonic'), 'Inert test engine');
  await fs.writeFile(path.join(oldCopy, 'runtime/bundle.zip'), 'Inert test resources');
  await fs.writeFile(path.join(oldCopy, 'runtime/manifest.json'), JSON.stringify(oldManifest));
  await fs.writeFile(path.join(oldCopy, 'ready.json'), JSON.stringify({ pin: oldPin }));
  await fs.writeFile(
    path.join(oldRoot, 'active.json'),
    JSON.stringify({ generation: oldGeneration }),
  );
  const savedBeforeStorage = await fs.readFile(manifestPath);
  const sourceBeforeStorage = await fs.readFile(path.join(folder, 'main.tex'));
  await settings();
  await page.getByRole('button', { name: 'Storage', exact: true }).click();
  const storageStarted = Date.now();
  // Each action rechecks native storage and refreshes the inventory. These
  // operations have their own bounded completion window, independent of the
  // short default matcher timeout used for immediate UI state.
  const storageActionWait = { timeout: 60_000 };
  const includedRow = page.locator(`[data-compiler-key="${status.pin.id}"]`);
  const oldRow = page.locator(`[data-compiler-key="${oldPin.id}"]`);
  await expect(includedRow).toContainText('Included with this Folio version', { timeout: 60_000 });
  const storageReviewMs = Date.now() - storageStarted;
  await expect(includedRow.getByRole('button', { name: 'Remove…', exact: true })).toBeDisabled();
  await expect(oldRow.getByRole('button', { name: 'Remove…', exact: true })).toBeEnabled(
    storageActionWait,
  );
  const compilerStorageBefore = await page.evaluate(() => window.folio.compilerStorage());
  await page.screenshot({ path: path.join(root, 'compiler-storage.png') });
  const storageCancellationDelayMs = 6000;
  await app.evaluate(({ dialog }, delayMs) => {
    globalThis.folioOriginalMessageBox = dialog.showMessageBox;
    dialog.showMessageBox = async (_window, options) => {
      globalThis.folioStorageConfirmation = options;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      return { response: 0, checkboxChecked: false };
    };
  }, storageCancellationDelayMs);
  const storageCancellationStarted = Date.now();
  await oldRow.getByRole('button', { name: 'Remove…', exact: true }).click();
  await expect(oldRow.getByRole('button', { name: 'Remove…', exact: true })).toBeEnabled(
    storageActionWait,
  );
  const storageCancellationMs = Date.now() - storageCancellationStarted;
  await fs.access(oldRoot);
  const confirmation = await app.evaluate(() => globalThis.folioStorageConfirmation);
  expect(confirmation.defaultId).toBe(0);
  expect(confirmation.cancelId).toBe(0);
  expect(confirmation.detail).toContain(oldPin.id);
  expect(confirmation.detail).toContain('Other saved resumes may need this exact compiler');
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = () =>
      new Promise((resolve) => {
        globalThis.folioResolveStorageConfirmation = resolve;
      });
  });
  await oldRow.getByRole('button', { name: 'Remove…', exact: true }).click();
  await expect
    .poll(
      () => app.evaluate(() => typeof globalThis.folioResolveStorageConfirmation),
      storageActionWait,
    )
    .toBe('function');
  await expect(page.getByRole('button', { name: 'Done', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'General', exact: true })).toBeDisabled();
  await page.keyboard.press('Escape');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  await expect(page.getByRole('dialog', { name: 'Settings', exact: true })).toBeVisible();
  await app.evaluate(() =>
    globalThis.folioResolveStorageConfirmation({ response: 0, checkboxChecked: false }),
  );
  await expect(page.getByRole('button', { name: 'Done', exact: true })).toBeEnabled(
    storageActionWait,
  );
  // Change the reviewed files while confirmation is pending; native IPC must
  // reject the stale token instead of accepting an old renderer decision.
  await app.evaluate(
    ({ dialog }, filename) => {
      dialog.showMessageBox = async () => {
        await process
          .getBuiltinModule('node:fs')
          .promises.appendFile(filename, 'Changed during review');
        return { response: 1, checkboxChecked: false };
      };
    },
    path.join(oldCopy, 'runtime/bundle.zip'),
  );
  await oldRow.getByRole('button', { name: 'Remove…', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Compiler files changed', storageActionWait);
  await fs.access(oldRoot);
  // A user confirmation and the subsequent inventory refresh are asynchronous.
  // Keep the confirmation open beyond Playwright's default five-second matcher
  // timeout, then require the real removal and refreshed UI to finish.
  const storageConfirmationDelayMs = 6000;
  await app.evaluate(({ dialog }, delayMs) => {
    dialog.showMessageBox = async () => {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      return { response: 1, checkboxChecked: false };
    };
  }, storageConfirmationDelayMs);
  await oldRow.getByRole('button', { name: 'Remove…', exact: true }).click();
  await expect(oldRow).toHaveCount(0, storageActionWait);
  await expect(page.getByRole('status')).toContainText('Compiler files removed');
  await expect(fs.access(oldRoot)).rejects.toThrow();
  await expect(includedRow.getByRole('button', { name: 'Remove…', exact: true })).toBeDisabled();
  const compilerStorageAfter = await page.evaluate(() => window.folio.compilerStorage());
  expect(compilerStorageAfter.bytes).toBeLessThan(compilerStorageBefore.bytes);
  expect(await fs.readFile(manifestPath)).toEqual(savedBeforeStorage);
  expect(await fs.readFile(path.join(folder, 'main.tex'))).toEqual(sourceBeforeStorage);
  await page.screenshot({ path: path.join(root, 'compiler-storage-removed.png') });
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = globalThis.folioOriginalMessageBox;
  });
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await page.getByRole('button', { name: 'Compile', exact: true }).click();
  await page.getByText('Up to date', { exact: true }).waitFor({ timeout: 60_000 });
  console.log(
    'PASS: compiler storage protects the included compiler, cancels removal, rejects changed files, removes an old version and preserves source/pin/PDF building.',
  );

  const zip = path.join(root, 'source.zip');
  await app.evaluate(({ dialog }, filePath) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath });
  }, zip);
  await page.getByRole('button', { name: 'More project actions', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Export LaTeX source…', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('ZIP archive');
  const exported = unzipSync(await fs.readFile(zip));
  expect(JSON.parse(Buffer.from(exported['resume.project.json']).toString()).runtime).toEqual(
    status.pin,
  );
  const missing = path.join(root, 'missing-version');
  await fs.mkdir(missing);
  await fs.writeFile(
    path.join(missing, 'main.tex'),
    await fs.readFile(path.join(folder, 'main.tex')),
  );
  await fs.writeFile(
    path.join(missing, 'resume.project.json'),
    JSON.stringify({
      ...original,
      id: 'missing-runtime-project',
      runtime: { ...status.pin, id: 'e'.repeat(64) },
    }),
  );
  await choose(path.join(missing, 'main.tex'));
  await page.getByRole('button', { name: 'Open project', exact: true }).click();
  await page.getByRole('button', { name: 'Compiler needs attention', exact: true }).waitFor();
  await settings();
  await expect(page.locator('.runtime-details')).toContainText('recorded compiler is missing');
  await expect(page.getByRole('button', { name: 'Repair compiler', exact: true })).toBeDisabled();
  await expect(page.locator('.runtime-details')).toContainText('You can still edit and save');
  const doneBounds = await page.getByRole('button', { name: 'Done', exact: true }).boundingBox();
  expect(doneBounds.y + doneBounds.height).toBeLessThan(680);
  await page.screenshot({ path: path.join(root, 'missing-recorded-version.png') });
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await page.getByRole('tab', { name: 'Code', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Compile', exact: true })).toBeDisabled();
  expect(
    JSON.parse(await fs.readFile(path.join(missing, 'resume.project.json'), 'utf8')).runtime.id,
  ).toBe('e'.repeat(64));
  await choose(path.join(folder, 'main.tex'));
  await page.getByRole('button', { name: 'Open project', exact: true }).click();
  await expect(page.getByLabel('Message the resume agent')).toBeEnabled();
  await close();
  await launch();
  const recovered = JSON.parse(await fs.readFile(path.join(data, 'recovery.json'), 'utf8'));
  expect(recovered.project.runtime).toEqual(status.pin);
  const resumed = await page.evaluate((pin) => window.folio.inspectRuntime(pin), status.pin);
  expect(resumed.ready, resumed.message).toBe(true);
  expect(JSON.parse(await fs.readFile(pointerFile, 'utf8')).generation).toBe(
    repairedPointer.generation,
  );
  const boot = await page.evaluate(() => window.folio.bootstrap());
  await app.evaluate(({ ipcMain }, boot) => {
    ipcMain.removeHandler('app:bootstrap');
    let attempts = 0;
    ipcMain.handle('app:bootstrap', () => {
      if (++attempts === 1) throw new Error('Synthetic recovery read failure');
      return boot;
    });
  }, boot);
  await page.reload();
  await expect(page.getByRole('alert')).toContainText('Synthetic recovery read failure');
  await expect(page.locator('.app-shell')).toHaveAttribute('inert', '');
  await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(page.getByLabel('Message the resume agent')).toBeEnabled();
  await expect(page.getByLabel('Project name')).toHaveValue('Recovered resume');
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('app:bootstrap');
    // Retain the pending operation. An unreachable promise lets Electron's
    // reply channel be collected and turns this loading fixture into an error.
    ipcMain.handle(
      'app:bootstrap',
      () =>
        new Promise((resolve) => {
          globalThis.releaseBootstrap = resolve;
        }),
    );
  });
  await page.reload();
  await expect.poll(() => app.evaluate(() => typeof globalThis.releaseBootstrap)).toBe('function');
  await app.evaluate(() => {
    process.getBuiltinModule('node:v8').setFlagsFromString('--expose-gc');
    process.getBuiltinModule('node:vm').runInNewContext('gc')();
  });
  await expect(
    page.getByRole('heading', { name: 'Preparing your workspace', exact: true }),
  ).toBeVisible();
  await expect(page.locator('.app-shell')).toHaveAttribute('inert', '');
  await app.evaluate(({ BrowserWindow, dialog }) => {
    globalThis.startupDialogs = 0;
    dialog.showOpenDialog = async () => {
      globalThis.startupDialogs++;
      return { canceled: true, filePaths: [] };
    };
    for (const command of ['save', 'new', 'open', 'compile'])
      BrowserWindow.getAllWindows()[0].webContents.send('menu', command);
  });
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(await app.evaluate(() => globalThis.startupDialogs)).toBe(0);
  const beforeLoadingClose = await fs.readFile(path.join(data, 'recovery.json'), 'utf8');
  await close();
  expect(await fs.readFile(path.join(data, 'recovery.json'), 'utf8')).toBe(beforeLoadingClose);
  await launch();
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('app:bootstrap');
    ipcMain.handle('app:bootstrap', () => {
      throw new Error('Synthetic recovery read failure');
    });
  });
  await page.reload();
  await expect(page.getByRole('alert')).toContainText('Synthetic recovery read failure');
  const beforeFailedClose = await fs.readFile(path.join(data, 'recovery.json'), 'utf8');
  await page.screenshot({ path: path.join(root, 'startup-error.png') });
  await close();
  expect(await fs.readFile(path.join(data, 'recovery.json'), 'utf8')).toBe(beforeFailedClose);
  console.log(
    'PASS: startup errors keep recovery protected; Retry can reopen it, and closing after a load failure does not replace it.',
  );
  expect(errors, errors.join('\n')).toEqual([]);
  await fs.writeFile(
    path.join(root, 'result.json'),
    JSON.stringify(
      {
        passed: true,
        errors,
        pin: status.pin,
        editingReadyMs,
        earlySave: true,
        retainedDraft: true,
        compilerStorage: {
          storageReviewMs,
          storageConfirmationDelayMs,
          storageCancellationDelayMs,
          storageCancellationMs,
          before: compilerStorageBefore,
          after: compilerStorageAfter,
          cancelledRemoval: true,
          pendingConfirmationPreventsClose: true,
          changedDuringConfirmationRejected: true,
          sourceAndPinPreserved: true,
          realCompilerStillBuilds: true,
          confirmation: 'Native dialog call intercepted for deterministic choices',
        },
      },
      null,
      2,
    ),
  );
  console.log(
    'PASS: source ZIP, history and restart preserve the exact compiler; an unavailable recorded version never switches to the current one. No renderer errors.',
  );
  console.log(`Evidence: ${root}`);
} catch (error) {
  await page?.screenshot({ path: path.join(root, 'failure.png') }).catch(() => {});
  console.error(`Evidence: ${root}`);
  throw error;
} finally {
  await app?.evaluate(({ app }) => app.exit(0)).catch(() => {});
  await app?.close().catch(() => {});
}
