import { _electron as electron, expect } from '@playwright/test';
import { promises as fs } from 'node:fs';
import path from 'node:path';
const root = await fs.mkdtemp(path.resolve('test-results/compact-states-'));
const env = { ...process.env, FOLIO_USER_DATA: root };
delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({ args: [process.cwd()], env });
try {
  const page = await app.firstWindow();
  await expect(page.getByLabel('Message the resume agent')).toBeEnabled({ timeout: 120_000 });
  await page.getByText('Up to date', { exact: true }).waitFor({ timeout: 60_000 });
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('app:bootstrap');
    ipcMain.handle('app:bootstrap', () => ({
      recovered: null,
      recent: [],
      runtime: {
        ready: false,
        engine: 'Tectonic test fixture',
        bundle: 'fixture',
        platform: 'darwin-arm64',
        isolation: 'macos-seatbelt',
        message: 'Missing runtime test fixture',
      },
    }));
  });
  await page.reload();
  await page.getByRole('button', { name: 'Compiler needs attention', exact: true }).click();
  await page.getByRole('button', { name: 'About', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('Missing runtime test fixture');
  await page.getByRole('button', { name: 'Close dialog' }).click();
  await page.getByRole('tab', { name: 'Code', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Compile', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Export PDF', exact: true })).toBeDisabled();
  await expect(page.locator('.preview-empty')).toContainText('Compile your LaTeX');
  const saved = path.join(root, 'saved');
  await fs.mkdir(saved);
  await app.evaluate(({ dialog }, saved) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [saved] });
  }, saved);
  await page.locator('.cm-content').focus();
  await app.evaluate(({ Menu }) => {
    const item = Menu.getApplicationMenu()
      .items.find((item) => item.label === 'File')
      .submenu.items.find((item) => item.label === 'Save project');
    if (item.accelerator !== 'CmdOrCtrl+S') throw new Error('Save shortcut changed');
    item.click();
  });
  await page.getByText('Saved locally', { exact: true }).waitFor();
  expect(await fs.readFile(path.join(saved, 'main.tex'), 'utf8')).toContain('documentclass');
  console.log(
    'PASS: missing-runtime alert/settings, disabled compiler/PDF export, empty preview, and native Save action/shortcut binding without a runtime.',
  );
} finally {
  await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
  await app.close().catch(() => {});
}
