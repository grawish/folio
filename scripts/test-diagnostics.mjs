import { _electron as electron, expect } from '@playwright/test';
import { promises as fs } from 'node:fs';
import path from 'node:path';

await fs.mkdir('test-results', { recursive: true });
const root = await fs.mkdtemp(path.resolve('test-results/diagnostics-'));
const env = { ...process.env, FOLIO_USER_DATA: path.join(root, 'data') };
delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({
  ...(process.argv[2]
    ? { executablePath: path.resolve(process.argv[2]), args: [] }
    : { args: [process.cwd()] }),
  env,
  timeout: 60_000,
});
const errors = [];
const results = [];
let page;
try {
  page = await app.firstWindow();
  page.setDefaultTimeout(15_000);
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (item) => {
    if (item.type() === 'error') errors.push(item.text());
  });
  await expect(page.getByLabel('Message the resume agent')).toBeEnabled({ timeout: 120_000 });
  await page.getByText('Up to date', { exact: true }).waitFor({ timeout: 60_000 });
  await expect(page.locator('.preview-pane .textLayer')).toContainText('Alex Morgan');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1480, 960));
  await page.getByRole('tab', { name: 'Code', exact: true }).click();
  await page.getByLabel('Auto-compile', { exact: true }).uncheck();
  const compile = async (source) => {
    await page.locator('.cm-content').fill(source);
    await page.getByRole('button', { name: 'Compile', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Compile', exact: true })).toBeVisible({
      timeout: 60_000,
    });
  };
  const cases = [
    {
      id: 'package',
      source:
        '\\documentclass{article}\n\\usepackage{folio-unavailable}\n\\begin{document}Sample\\end{document}',
      title: 'Missing LaTeX package or class: folio-unavailable.sty',
      hasSourceLink: true,
      evidence: 'folio-unavailable.sty',
    },
    {
      id: 'file',
      source:
        '\\documentclass{article}\n\\begin{document}\n\\input{sections/missing}\n\\end{document}',
      title: 'Missing project file: sections/missing.tex',
      hasSourceLink: true,
      evidence: 'sections/missing.tex',
    },
    {
      id: 'engine',
      source:
        '\\documentclass{article}\n\\usepackage{iftex}\\RequireLuaTeX\n\\begin{document}Sample\\end{document}',
      title: 'This document requires LuaTeX',
      evidence: 'LuaTeX is required to compile this document.',
    },
    {
      id: 'font',
      source:
        '\\documentclass{article}\n\\usepackage{fontspec}\n\\setmainfont{Folio Missing Font}\n\\begin{document}Sample\\end{document}',
      title: 'Font not found: Folio Missing Font',
      hasSourceLink: true,
      evidence: 'Folio Missing Font',
    },
  ];
  for (const sample of cases) {
    await compile(sample.source);
    await expect(page.locator('#build-help-title')).toHaveText(sample.title);
    await expect(page.locator('.preview-pane .textLayer')).toContainText('Alex Morgan');
    await expect(page.locator('.stale-note')).toBeVisible();
    await page.screenshot({ path: path.join(root, `${sample.id}.png`) });
    let sourceLine;
    if (sample.hasSourceLink) {
      const original = page
        .locator('.diagnostic.error')
        .filter({ hasText: /main\.tex:\d+/ })
        .first();
      // TeX can discover an error after reading the next line. Navigation must
      // follow its actual report rather than guess the offending command line.
      sourceLine = Number((await original.textContent()).match(/main\.tex:(\d+)/)[1]);
      expect(sourceLine).toBeGreaterThan(0);
      await original.click();
      await expect(page.locator('.app-status')).toContainText(`Ln ${sourceLine}, Col 1`);
    }
    await page.getByRole('button', { name: 'Raw log', exact: true }).click();
    await expect(page.locator('.diagnostics-panel pre')).toContainText(sample.evidence);
    if (sourceLine)
      await expect(page.locator('.diagnostics-panel pre')).toContainText(`main.tex:${sourceLine}:`);
    await page.getByRole('button', { name: 'Diagnostics', exact: true }).click();
    results.push({
      kind: sample.id,
      lastGoodRetained: true,
      rawLogRetained: true,
      sourceLine,
    });
  }
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1040, 680));
  await expect.poll(() => page.evaluate(() => innerWidth)).toBe(1040);
  await page.locator('.diagnostic-list').evaluate((node) => {
    node.scrollTop = 0;
  });
  await page.screenshot({ path: path.join(root, 'font-compact-dark.png') });
  expect(
    await page.locator('.build-help').evaluate((node) => node.scrollWidth <= node.clientWidth),
  ).toBe(true);
  await page.locator('.diagnostic.error').last().scrollIntoViewIfNeeded();
  await expect(page.locator('.diagnostic.error').last()).toBeInViewport();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByLabel('Appearance', { exact: true }).selectOption('light');
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await page.locator('.diagnostic-list').evaluate((node) => {
    node.scrollTop = 0;
  });
  await page.screenshot({ path: path.join(root, 'font-compact-light.png') });
  await compile(cases[3].source.replace('Folio Missing Font', 'lmroman10-regular.otf'));
  await page.getByText('Up to date', { exact: true }).waitFor();
  await expect(page.locator('.build-help')).toHaveCount(0);
  await expect(page.locator('.preview-pane .textLayer')).toContainText('Sample');
  await expect(page.locator('.stale-note')).toHaveCount(0);
  expect(errors, errors.join('\n')).toEqual([]);
  await fs.writeFile(
    path.join(root, 'result.json'),
    JSON.stringify({ passed: true, errors, cases: results }, null, 2),
  );
  console.log(
    'PASS: real package, file, engine and font errors show specific advice, retain the PDF and preserve raw logs/source links.',
  );
  console.log(
    'PASS: compact dark/light layouts scroll without horizontal overflow; the suggested bundled font repairs the build.',
  );
  console.log(`Evidence: ${root}`);
} catch (error) {
  await page?.screenshot({ path: path.join(root, 'failure.png') }).catch(() => {});
  await fs.writeFile(
    path.join(root, 'result.json'),
    JSON.stringify({ passed: false, error: error.message, errors, cases: results }, null, 2),
  );
  console.error(`Evidence: ${root}`);
  throw error;
} finally {
  await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
  await app.close().catch(() => {});
}
