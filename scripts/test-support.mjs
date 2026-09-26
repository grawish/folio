import { _electron as electron, expect } from '@playwright/test';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { unzipSync, strFromU8 } from 'fflate';

await fs.mkdir('test-results', { recursive: true });
const root = await fs.mkdtemp(path.resolve('test-results/support-'));
const canary = 'FolioPrivateCanary',
  filename = path.join(root, 'support.zip');
const env = {
  ...process.env,
  FOLIO_USER_DATA: path.join(root, 'data'),
  FOLIO_TEST_PRIVATE_SECRET: canary,
};
delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({
  ...(process.argv[2]
    ? { executablePath: path.resolve(process.argv[2]), args: [] }
    : { args: [process.cwd()] }),
  env,
  timeout: 60_000,
});
const errors = [],
  checks = [];
let page;
const settings = async () => {
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Privacy', exact: true }).click();
};
const support = async () => {
  await settings();
  await page.getByRole('button', { name: 'Review support bundle', exact: true }).click();
  await expect(page.locator('.support-preview pre')).toContainText('folio-support-v1');
};
const files = async () => {
  const result = {};
  for (const [label, file] of [
    ['App and Mac versions', 'app.json'],
    ['Compiler and last build', 'compiler.json'],
    ['Workspace summary', 'workspace.json'],
    ['AI connection summary', 'ai.json'],
  ]) {
    await page
      .getByRole('navigation', { name: 'Support sections' })
      .getByRole('button', { name: new RegExp(label) })
      .click();
    result[file] = await page.locator('.support-preview pre').innerText();
  }
  return result;
};
const closeSupport = async () => {
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await page.getByRole('button', { name: 'Done', exact: true }).click();
};
try {
  page = await app.firstWindow();
  page.setDefaultTimeout(15_000);
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (e) => {
    if (e.type() === 'error') errors.push(e.text());
  });
  await expect(page.getByLabel('Message the resume agent')).toBeEnabled({ timeout: 120_000 });
  await page.getByText('Up to date', { exact: true }).waitFor({ timeout: 60_000 });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1480, 960));
  await page
    .getByLabel('Message the resume agent')
    .fill(`${canary} private chat draft owner@example.invalid`);
  await page.getByRole('tab', { name: 'Code', exact: true }).click();
  await page.getByLabel('Auto-compile', { exact: true }).uncheck();
  await page
    .locator('.cm-content')
    .fill(
      `\\documentclass{article}\n\\usepackage{fontspec}\n\\setmainfont{${canary}}\n\\begin{document}Private resume owner@example.invalid\\end{document}`,
    );
  await page.getByRole('button', { name: 'Compile', exact: true }).click();
  await expect(page.locator('#build-help-title')).toContainText(canary, { timeout: 60_000 });
  await page.getByRole('tab', { name: 'Chat', exact: true }).click();
  await support();
  await expect(page.getByLabel('Include ai connection summary', { exact: true })).not.toBeChecked();
  const reviewed = await files();
  for (const text of Object.values(reviewed)) {
    expect(text).not.toContain(canary);
    expect(text).not.toContain('owner@example.invalid');
    expect(text).not.toContain(root);
    expect(text).not.toContain('/Users/');
    expect(text).not.toContain('FOLIO_TEST_PRIVATE_SECRET');
  }
  expect(JSON.parse(reviewed['compiler.json'])).toMatchObject({
    build: 'error',
    problem: 'font',
    errors: expect.any(Number),
    buildMatchesSource: true,
  });
  await page
    .getByRole('navigation', { name: 'Support sections' })
    .getByRole('button', { name: /Compiler and last build/ })
    .click();
  await page.screenshot({ path: path.join(root, 'support-dark.png') });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1040, 680));
  await expect.poll(() => page.evaluate(() => innerWidth)).toBe(1040);
  for (const name of ['Save support ZIP', 'Close']) {
    const button = page.getByRole('button', { name, exact: true });
    await expect(button).toBeInViewport();
    expect(
      await button.evaluate((node) => {
        const r = node.getBoundingClientRect();
        return node.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
      }),
    ).toBe(true);
  }
  expect(
    await page.locator('.support-bundle').evaluate((node) => node.scrollWidth <= node.clientWidth),
  ).toBe(true);
  await page.screenshot({ path: path.join(root, 'support-small-dark.png') });
  await app.evaluate(({ dialog }) => {
    dialog.showSaveDialog = async () => ({ canceled: true });
  });
  await page.getByRole('button', { name: 'Save support ZIP', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Save support ZIP', exact: true })).toBeEnabled();
  await expect(page.locator('.support-preview pre')).toHaveText(reviewed['compiler.json'].trim());
  await expect(fs.access(filename)).rejects.toThrow();
  await page.getByLabel('Include workspace summary', { exact: true }).uncheck();
  await app.evaluate(({ dialog }, filePath) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath });
  }, filename);
  await page.getByRole('button', { name: 'Save support ZIP', exact: true }).click();
  await expect(page.locator('.support-bundle [role="status"]')).toContainText('Saved locally');
  const archive = unzipSync(await fs.readFile(filename));
  expect(Object.keys(archive)).toEqual(['app.json', 'compiler.json']);
  for (const [name, bytes] of Object.entries(archive))
    expect(strFromU8(bytes)).toBe(reviewed[name]);
  expect((await fs.stat(filename)).mode & 0o777).toBe(0o600);
  checks.push(
    'real font failure retains only a fixed category; source, chat draft, paths and environment canaries absent from preview/export; exact selected bytes; cancelled save; private file mode',
  );

  await closeSupport();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByLabel('Appearance', { exact: true }).selectOption('light');
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await support();
  await page
    .getByRole('navigation', { name: 'Support sections' })
    .getByRole('button', { name: /Workspace summary/ })
    .click();
  await page.screenshot({ path: path.join(root, 'support-small-light.png') });
  for (const label of ['app and Mac versions', 'compiler and last build', 'workspace summary'])
    await page.getByLabel(`Include ${label.toLowerCase()}`, { exact: true }).uncheck();
  await expect(page.getByRole('button', { name: 'Save support ZIP', exact: true })).toBeDisabled();
  await page.getByLabel('Include ai connection summary', { exact: true }).check();
  const refreshed = await files();
  await page.getByRole('button', { name: 'Save support ZIP', exact: true }).click();
  await expect(page.locator('.support-bundle [role="status"]')).toContainText('Saved locally');
  expect(Object.keys(unzipSync(await fs.readFile(filename)))).toEqual(['ai.json']);
  expect(strFromU8(unzipSync(await fs.readFile(filename))['ai.json'])).toBe(refreshed['ai.json']);
  checks.push(
    'minimum-size dark/light review, zero-section guard, explicit optional AI summary and exact omission of every other file',
  );

  await page.reload();
  await expect(page.getByLabel('Message the resume agent')).toBeEnabled({ timeout: 120_000 });
  await support();
  const finalReview = await files();
  // A failed filesystem write must not claim success or replace the previous ZIP.
  const previousBytes = await fs.readFile(filename);
  await app.evaluate(({ dialog }, directory) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: directory });
  }, root);
  await page.getByRole('button', { name: 'Save support ZIP', exact: true }).click();
  await expect(page.locator('.support-bundle [role="alert"]')).toContainText('could not be saved');
  expect(await fs.readFile(filename)).toEqual(previousBytes);
  // Hold the atomic rename and ask to close. The native close must wait for the save.
  await app.evaluate(({ dialog }, target) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: target });
    const fs = process.getBuiltinModule('node:fs'),
      rename = fs.promises.rename;
    fs.promises.rename = async (...args) => {
      if (args[1] === target) {
        fs.promises.rename = rename;
        globalThis.supportWriteHeld = true;
        await new Promise((resolve) => {
          globalThis.releaseSupportWrite = resolve;
        });
      }
      return rename(...args);
    };
  }, filename);
  await page.getByRole('button', { name: 'Save support ZIP', exact: true }).click();
  await expect.poll(() => app.evaluate(() => globalThis.supportWriteHeld)).toBe(true);
  await expect(page.getByRole('button', { name: 'Saving…', exact: true })).toBeDisabled();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  expect(page.isClosed()).toBe(false);
  const closed = page.waitForEvent('close');
  await app.evaluate(() => globalThis.releaseSupportWrite());
  await closed;
  const finalArchive = unzipSync(await fs.readFile(filename));
  expect(Object.keys(finalArchive)).toEqual(['app.json', 'compiler.json', 'workspace.json']);
  for (const [name, bytes] of Object.entries(finalArchive))
    expect(strFromU8(bytes)).toBe(finalReview[name]);
  checks.push(
    'reload creates a fresh review; failed write preserves previous ZIP; retry and native close wait for atomic export',
  );
  expect(errors, errors.join('\n')).toEqual([]);
  await fs.writeFile(
    path.join(root, 'result.json'),
    JSON.stringify({ passed: true, errors, checks }, null, 2),
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
  await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
  await app.close().catch(() => {});
}
