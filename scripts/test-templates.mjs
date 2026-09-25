import { _electron as electron, expect } from '@playwright/test';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { unzipSync } from 'fflate';

const catalog = JSON.parse(await fs.readFile('resources/templates/catalog.json', 'utf8'));
const root = await fs.mkdtemp(path.resolve('test-results/templates-'));
const saved = path.join(root, 'saved');
await fs.mkdir(saved);
const env = { ...process.env, FOLIO_USER_DATA: path.join(root, 'app-data') };
delete env.ELECTRON_RUN_AS_NODE;
let app, page;
const errors = [];
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
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (item) => {
    if (item.type() === 'error') errors.push(item.text());
  });
  await expect(page.getByLabel('Message the resume agent')).toBeEnabled({ timeout: 120_000 });
};
const openPicker = () =>
  page.getByRole('button', { name: 'Explore templates', exact: true }).click();
const ready = () => page.getByText('Up to date', { exact: true }).waitFor({ timeout: 60_000 });
const close = async () => {
  const closed = page.waitForEvent('close');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  await closed;
  await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
  await app.close().catch(() => {});
};
try {
  await launch();
  await ready();
  await page.getByLabel('Project name', { exact: true }).fill('Keep my unsaved name');
  await openPicker();
  await expect(page.getByRole('dialog')).toContainText('All layouts support A4 and US Letter');
  await expect(page.locator('.template-card')).toHaveCount(catalog.length);
  await page.getByLabel('Paper size', { exact: true }).selectOption('letter');
  await page.getByRole('button', { name: 'Create The Minimal resume', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('Keep your latest changes?');
  await page.getByRole('button', { name: 'Keep editing', exact: true }).click();
  await expect(page.getByLabel('Project name', { exact: true })).toHaveValue(
    'Keep my unsaved name',
  );

  for (const paper of ['a4', 'letter']) {
    for (const template of catalog) {
      await openPicker();
      await page.getByLabel('Paper size', { exact: true }).selectOption(paper);
      const button = page.getByRole('button', {
        name: `Create ${template.name} resume`,
        exact: true,
      });
      await button.scrollIntoViewIfNeeded();
      await expect(button).toContainText(template.font);
      const cardContentFits = () =>
        button.evaluate((card) => {
          const bounds = card.getBoundingClientRect();
          const meta = card.querySelector('.template-meta').getBoundingClientRect();
          return meta.bottom <= bounds.bottom && card.scrollHeight <= card.clientHeight + 1;
        });
      expect(await cardContentFits(), 'Template names and details must not be clipped').toBe(true);
      await expect
        .poll(() =>
          button.locator('img').evaluate((image) => image.complete && image.naturalWidth > 0),
        )
        .toBe(true);
      await expect(button.locator('img')).toHaveAttribute(
        'src',
        `./templates/${template.id}-${paper}.png`,
      );
      if (template.id === 'classic' && paper === 'a4') {
        await page.screenshot({ path: path.join(root, 'picker-dark.png') });
        await app.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()[0].setSize(1040, 680),
        );
        await page.screenshot({ path: path.join(root, 'picker-small-dark.png') });
        const bounds = await page.getByRole('dialog').boundingBox();
        expect(bounds.y).toBeGreaterThanOrEqual(0);
        expect(bounds.y + bounds.height).toBeLessThanOrEqual(680);
        expect(
          await page
            .getByRole('dialog')
            .evaluate((dialog) => dialog.scrollHeight <= dialog.clientHeight + 1),
        ).toBe(true);
        const footnote = await page.locator('.modal-footnote').boundingBox();
        expect(footnote.y + footnote.height).toBeLessThan(bounds.y + bounds.height);
        expect(await cardContentFits(), 'Small-window cards must retain their full content').toBe(
          true,
        );
        expect(
          await page
            .locator('.template-grid')
            .evaluate((grid) => grid.scrollWidth <= grid.clientWidth + 1),
        ).toBe(true);
      }
      if (template.id === 'two-column' && paper === 'letter')
        await page.screenshot({ path: path.join(root, 'picker-small-light-last-row.png') });
      await button.focus();
      await page.keyboard.press('Enter');
      if (await page.getByRole('button', { name: 'Discard changes', exact: true }).isVisible())
        await page.getByRole('button', { name: 'Discard changes', exact: true }).click();
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await expect(page.getByRole('tab', { name: 'Chat', exact: true })).toHaveAttribute(
        'aria-selected',
        'true',
      );
      await ready();
      await expect(page.locator('.preview-pane .textLayer')).toHaveCount(1);
      await expect(page.locator('.preview-pane .textLayer')).toContainText(template.sampleName);
      await page.getByRole('tab', { name: 'Code', exact: true }).click();
      await expect(page.locator('.cm-content')).toContainText(
        `${paper === 'a4' ? 'a4' : 'letter'}paper`,
      );
      const filename = path.join(root, `${template.id}-${paper}.pdf`);
      await app.evaluate(({ dialog }, filename) => {
        dialog.showSaveDialog = async () => ({ canceled: false, filePath: filename });
      }, filename);
      await page.getByRole('button', { name: 'Export PDF', exact: true }).click();
      await expect
        .poll(() =>
          fs.stat(filename).then(
            () => true,
            () => false,
          ),
        )
        .toBe(true);
      const info = execFileSync('pdfinfo', [filename], { encoding: 'utf8' });
      const size = /Page size:\s*([\d.]+) x ([\d.]+)/.exec(info);
      expect(size).not.toBeNull();
      expect(Math.abs(Number(size[1]) - (paper === 'a4' ? 595.276 : 612))).toBeLessThan(0.2);
      expect(Math.abs(Number(size[2]) - (paper === 'a4' ? 841.89 : 792))).toBeLessThan(0.2);
      if (template.id === 'two-column') {
        await page.getByRole('tab', { name: 'Chat', exact: true }).click();
        await page.screenshot({ path: path.join(root, `two-column-${paper}.png`) });
      }
      console.log(
        `PASS: ${template.id} ${paper}, real preview, keyboard selection, actual PDF text and export dimensions.`,
      );
    }
    if (paper === 'a4')
      await page.getByRole('button', { name: 'Switch to light mode', exact: true }).click();
  }
  await app.evaluate(({ dialog }, folder) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] });
  }, saved);
  await page.getByRole('button', { name: 'Save project', exact: true }).click();
  await page.getByText('Saved locally', { exact: true }).waitFor();
  const metadata = JSON.parse(await fs.readFile(path.join(saved, 'resume.project.json'), 'utf8'));
  expect(metadata.templateId).toBe('two-column');
  expect(metadata.templateVersion).toBe(1);
  const zip = path.join(root, 'template-source.zip');
  await app.evaluate(({ dialog }, filename) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: filename });
  }, zip);
  await page.getByRole('button', { name: 'More project actions' }).click();
  await page.getByRole('menuitem', { name: 'Export LaTeX source…', exact: true }).click();
  await expect
    .poll(() =>
      fs.stat(zip).then(
        () => true,
        () => false,
      ),
    )
    .toBe(true);
  const archive = unzipSync(await fs.readFile(zip));
  expect(JSON.parse(Buffer.from(archive['resume.project.json']).toString()).templateVersion).toBe(
    1,
  );
  expect(Buffer.from(archive['main.tex']).toString()).toContain('10pt,letterpaper');
  await close();
  await launch();
  await ready();
  await expect(page.locator('.preview-pane .textLayer')).toContainText('Sam Patel');
  await page.getByRole('tab', { name: 'Code', exact: true }).click();
  await expect(page.locator('.cm-content')).toContainText('letterpaper');
  expect(errors, errors.join('\n')).toEqual([]);
  await fs.writeFile(
    path.join(root, 'result.json'),
    JSON.stringify({ passed: true, variants: catalog.length * 2, errors }, null, 2),
  );
  console.log(
    `PASS: unsaved guard, template version/source export and restart. No renderer errors.\nEvidence: ${root}`,
  );
} finally {
  await app?.evaluate(({ app }) => app.exit(0)).catch(() => {});
  await app?.close().catch(() => {});
}
