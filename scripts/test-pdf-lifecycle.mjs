import { _electron as electron, expect } from '@playwright/test';
import { promises as fs } from 'node:fs';
import path from 'node:path';

// Delay only the next PDF worker load. Resizing the visible, earlier PDF while
// its replacement is pending reproduces a document-lifetime race reliably.
const root = await fs.mkdtemp(path.resolve('test-results/pdf-lifecycle-'));
const env = { ...process.env, FOLIO_USER_DATA: path.join(root, 'data') };
delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({
  ...(process.argv[2]
    ? { executablePath: path.resolve(process.argv[2]), args: [] }
    : { args: [process.cwd()] }),
  env,
  timeout: 60_000,
});
let page;
const errors = [];
try {
  page = await app.firstWindow();
  page.setDefaultTimeout(15_000);
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (item) => {
    if (item.type() === 'error') errors.push(item.text());
  });
  await expect(page.getByLabel('Message the resume agent')).toBeEnabled({ timeout: 120_000 });
  await page.getByText('Up to date', { exact: true }).waitFor({ timeout: 60_000 });
  await page.getByRole('tab', { name: 'Code', exact: true }).click();
  await page.getByLabel('Auto-compile', { exact: true }).uncheck();
  const source = String.raw`\documentclass{article}
\usepackage{hyperref}
\begin{document}
\section*{First PDF}
\href{https://example.com}{Example link}
\newpage
Second page remains readable.
\end{document}`;
  await page.locator('.cm-content').fill(source);
  await page.getByRole('button', { name: 'Compile', exact: true }).click();
  const firstPage = page.locator('.preview-pane .textLayer').first();
  await expect(firstPage).toContainText('First PDF', { timeout: 60_000 });
  await expect(page.locator('.pdf-links a').first()).toHaveAttribute(
    'href',
    'https://example.com/',
  );
  await page.getByRole('button', { name: 'Next page', exact: true }).click();
  await expect(page.locator('.page-controls')).toContainText('2 / 2');
  await expect
    .poll(() => page.locator('.preview-scroll').evaluate((node) => node.scrollTop))
    .toBeGreaterThan(200);

  await page.evaluate(() => {
    const original = Worker.prototype.postMessage;
    window.pdfLoadHeld = false;
    Worker.prototype.postMessage = function (...args) {
      if (args[0]?.action === 'GetDocRequest') {
        Worker.prototype.postMessage = original;
        window.pdfLoadHeld = true;
        window.releasePdfLoad = () => original.apply(this, args);
        return;
      }
      return original.apply(this, args);
    };
  });
  await page.locator('.cm-content').fill(source.replace('First PDF', 'Replacement PDF'));
  await page.getByRole('button', { name: 'Compile', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.pdfLoadHeld), { timeout: 60_000 }).toBe(true);
  await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
  await page
    .getByRole('separator', { name: 'Resize writing and PDF panes' })
    .press('Shift+ArrowLeft');
  await page.getByRole('button', { name: 'Hide sidebar', exact: true }).click();
  await page.waitForTimeout(500);
  expect(errors, errors.join('\n')).toEqual([]);
  await expect(firstPage).toContainText('First PDF');
  await expect(page.getByRole('toolbar', { name: 'PDF annotation tools' })).toHaveCount(0);
  const scrollBeforeReplace = await page
    .locator('.preview-scroll')
    .evaluate((node) => node.scrollTop);
  await page.evaluate(() => window.releasePdfLoad());
  await expect(firstPage).toContainText('Replacement PDF', { timeout: 60_000 });
  await expect(page.locator('.zoom-controls')).toContainText('110%');
  await expect(page.locator('.page-controls')).toContainText('2 / 2');
  expect(await page.locator('.preview-scroll').evaluate((node) => node.scrollTop)).toBeCloseTo(
    scrollBeforeReplace,
    0,
  );
  await expect(page.getByRole('toolbar', { name: 'PDF annotation tools' })).toBeVisible();
  await expect(page.locator('.pdf-links a').first()).toHaveAttribute(
    'href',
    'https://example.com/',
  );
  await page.screenshot({ path: path.join(root, 'replaced-pdf.png') });

  // Replacing a pending load must also dispose it without affecting the next PDF.
  await page.evaluate(() => {
    const original = Worker.prototype.postMessage;
    window.pdfLoadHeld = false;
    Worker.prototype.postMessage = function (...args) {
      if (args[0]?.action === 'GetDocRequest') {
        Worker.prototype.postMessage = original;
        window.pdfLoadHeld = true;
        return;
      }
      return original.apply(this, args);
    };
  });
  await page.locator('.cm-content').fill(source.replace('First PDF', 'Superseded PDF'));
  await page.getByRole('button', { name: 'Compile', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.pdfLoadHeld), { timeout: 60_000 }).toBe(true);
  await page.locator('.cm-content').fill(source.replace('First PDF', 'Final PDF'));
  await page.getByRole('button', { name: 'Compile', exact: true }).click();
  await expect(firstPage).toContainText('Final PDF', { timeout: 60_000 });
  expect(errors, errors.join('\n')).toEqual([]);
  await fs.writeFile(
    path.join(root, 'result.json'),
    JSON.stringify({ passed: true, errors }, null, 2),
  );
  console.log(
    'PASS: pending PDF replacement survives resizing and zoom; notes wait for matching bytes; page, zoom and scroll remain; superseded loads cancel without renderer errors.',
  );
  console.log(`Evidence: ${root}`);
} catch (error) {
  await page?.screenshot({ path: path.join(root, 'failure.png') }).catch(() => {});
  console.error(`Evidence: ${root}`);
  throw error;
} finally {
  await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
  await app.close().catch(() => {});
}
