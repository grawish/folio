import { _electron as electron, expect } from '@playwright/test';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const executablePath =
  process.argv[2] ?? path.resolve('release/mac-arm64/Folio.app/Contents/MacOS/Folio');
const sourceBuild = process.argv[2] === '--source';
await fs.mkdir('test-results', { recursive: true });
const data = await fs.mkdtemp(path.resolve('test-results/packaged-'));
const env = { ...process.env, FOLIO_USER_DATA: data };
delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({
  ...(sourceBuild ? { args: [process.cwd()] } : { executablePath, args: [] }),
  env,
  timeout: 60_000,
});
let page;
const errors = [];
try {
  page = await app.firstWindow();
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (item) => {
    if (item.type() === 'error') errors.push(item.text());
  });
  await expect(page.getByLabel('Message the resume agent')).toBeEnabled({ timeout: 120_000 });
  await page.getByText('Up to date', { exact: true }).waitFor({ timeout: 60_000 });
  await expect(page.locator('.preview-pane .textLayer')).toContainText('Alex Morgan', {
    timeout: 20_000,
  });
  await page.screenshot({ path: path.resolve('test-results/packaged-workspace.png') });
  await expect(page.getByRole('tab', { name: 'Chat', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'About', exact: true }).click();
  await expect(page.getByText('Your LaTeX compiler is ready.', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Close dialog' }).click();
  console.log(
    `PASS: ${sourceBuild ? 'source desktop build' : 'standalone packaged app'} compiles with its managed compiler and bundle.`,
  );
  const compatibility = await fs.readFile('resources/runtime-checks/resume-packages.tex', 'utf8');
  await page.getByRole('tab', { name: 'Code', exact: true }).click();
  await page.locator('.cm-content').fill(compatibility);
  await expect(page.locator('.preview-pane .textLayer')).toContainText(
    'Offline Bibliography Compatibility',
    { timeout: 60_000 },
  );
  await page.getByText('Up to date', { exact: true }).waitFor({ timeout: 60_000 });
  expect(errors, errors.join('\n')).toEqual([]);
  console.log('PASS: imported resume packages, fonts, and Biber render in the desktop app.');
  console.log(`Evidence: ${data}`);
} catch (error) {
  if (page) {
    await page.screenshot({ path: path.join(data, 'failure.png') }).catch(() => {});
    const raw = page.getByRole('button', { name: 'Raw log', exact: true });
    if (await raw.isVisible().catch(() => false)) {
      await raw.click();
      await fs.writeFile(
        path.join(data, 'failed-build.log'),
        await page.locator('.diagnostics-panel pre').innerText(),
      );
    }
  }
  console.error(`Evidence: ${data}`);
  throw error;
} finally {
  await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
  await app.close().catch(() => {});
}
