import { _electron as electron, expect } from '@playwright/test';
import { promises as fs } from 'node:fs';
import path from 'node:path';
const templateCatalog = JSON.parse(await fs.readFile('resources/templates/catalog.json', 'utf8'));
import { unzipSync, strFromU8 } from 'fflate';

await fs.mkdir('test-results', { recursive: true });
const root = await fs.mkdtemp(path.resolve('test-results/compact-'));
const fixture = path.join(root, 'fixture');
await fs.mkdir(path.join(fixture, 'sections'), { recursive: true });
await fs.mkdir(path.join(fixture, 'notes'), { recursive: true });
const source =
  '\\documentclass{article}\n\\usepackage{hyperref}\n\\begin{document}\n\\input{sections/body}\n\\newpage Second page\n\\end{document}';
const body = 'Compact feature parity. \\href{https://example.com}{Example link}';
await fs.writeFile(path.join(fixture, 'main.tex'), source);
await fs.writeFile(
  path.join(fixture, 'alternative.tex'),
  '\\documentclass{article}\\begin{document}Alternative entry document\\end{document}',
);
await fs.writeFile(path.join(fixture, 'sections/body.tex'), body);
await fs.writeFile(
  path.join(fixture, 'notes/body.tex'),
  '% A distinct file with the same basename.',
);
for (let i = 0; i < 35; i++)
  await fs.writeFile(path.join(fixture, 'notes', `long-filename-${i}.tex`), `% Note ${i}`);
const env = { ...process.env, FOLIO_USER_DATA: path.join(root, 'data') };
delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({ args: [process.cwd()], env, timeout: 60_000 });
try {
  const page = await app.firstWindow();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await expect(page.getByLabel('Message the resume agent')).toBeEnabled({ timeout: 120_000 });
  const editor = page.locator('.cm-content');
  const ready = () => page.getByText('Up to date', { exact: true }).waitFor({ timeout: 60_000 });
  const menu = async (name) => {
    await page.getByRole('button', { name: 'More project actions', exact: true }).click();
    await page.getByRole('menuitem', { name, exact: true }).click();
  };
  const close = () => page.getByRole('button', { name: 'Close dialog', exact: true }).click();
  const choosePath = (selected) =>
    app.evaluate(({ dialog }, selected) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] });
    }, selected);
  const compile = async () => {
    await page.getByRole('button', { name: 'Compile', exact: true }).click();
    await ready();
  };
  await ready();
  await choosePath(path.join(fixture, 'main.tex'));
  await page.getByRole('button', { name: 'Open project', exact: true }).click();
  await expect(page.locator('.preview-pane .textLayer').first()).toContainText(
    'Compact feature parity',
    { timeout: 60_000 },
  );
  await page.getByRole('tab', { name: 'Code', exact: true }).click();
  await page.getByRole('checkbox', { name: 'Auto-compile', exact: true }).uncheck();
  await expect(page.getByLabel('Main document', { exact: true })).toHaveValue('main.tex');
  await page.getByRole('button', { name: 'Next page', exact: true }).click();
  await expect(page.locator('.page-controls')).toContainText('2 / 2');
  await page.getByRole('button', { name: 'Previous page', exact: true }).click();
  await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
  await expect(page.locator('.zoom-controls')).toContainText('110%');
  await page.getByRole('button', { name: 'Zoom out', exact: true }).click();
  await page.getByRole('button', { name: 'Fit to width', exact: true }).click();
  await expect(page.locator('.pdf-links a').first()).toHaveAttribute(
    'href',
    'https://example.com/',
  );
  console.log('PASS: multi-file import, two-page preview, links, zoom, fit, and navigation.');

  await page.getByLabel('Main document', { exact: true }).selectOption('alternative.tex');
  await expect(editor).toHaveAttribute('aria-label', 'LaTeX source: main.tex');
  await compile();
  await expect(page.locator('.textLayer')).toContainText('Alternative entry document');
  await page.getByLabel('Main document', { exact: true }).selectOption('main.tex');
  await page.getByRole('button', { name: 'notes/body.tex', exact: true }).click();
  await expect(editor).toContainText('same basename');
  await page.getByRole('button', { name: 'sections/body.tex', exact: true }).click();
  await expect(editor).toContainText('Compact feature parity');
  await page.getByRole('button', { name: 'Folder sections', exact: true }).click();
  await expect(page.getByRole('button', { name: 'sections/body.tex', exact: true })).toHaveCount(0);
  await page.locator('.editor-tab').filter({ hasText: 'main.tex' }).click();
  await page.locator('.editor-tab[title="sections/body.tex"]').click();
  await expect(page.getByRole('button', { name: 'sections/body.tex', exact: true })).toBeVisible();
  console.log(
    'PASS: main-document independence, duplicate basenames, and folder reopening from tabs.',
  );

  await editor.fill('\\undefinedParityCommand');
  await page.getByRole('button', { name: 'Compile', exact: true }).click();
  await page.getByText('Build needs attention', { exact: true }).waitFor({ timeout: 60_000 });
  await page.locator('.editor-tab[title="main.tex"]').click();
  await page.locator('.diagnostic.error').filter({ hasText: 'sections/body' }).first().click();
  await expect(editor).toHaveAttribute('aria-label', 'LaTeX source: sections/body.tex');
  await page.getByRole('button', { name: 'Raw log', exact: true }).click();
  await expect(page.locator('.diagnostics-panel pre')).toContainText('Undefined control sequence');
  await page.getByRole('button', { name: 'Close build output' }).click();
  await page.locator('.app-status button').click();
  await expect(page.locator('.diagnostics-panel')).toBeVisible();
  await editor.fill(body);
  await compile();
  await page.getByRole('button', { name: 'Close build output' }).click();
  console.log('PASS: source-linked diagnostics, raw logs, footer toggle, and error recovery.');

  await page.locator('.editor-tab[title="main.tex"]').click();
  await editor.press('ControlOrMeta+End');
  await page.keyboard.insertText('\n% preserve editor state');
  await page.getByRole('button', { name: 'Hide sidebar', exact: true }).click();
  await menu('Main document…');
  await expect(page.getByRole('dialog').getByLabel('Main document')).toHaveValue('main.tex');
  await close();
  await menu('Settings');
  await page.getByLabel('Appearance', { exact: true }).selectOption('light');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.getByRole('button', { name: 'Editor & PDF', exact: true }).click();
  await page.getByLabel('Editor text size', { exact: true }).selectOption('18');
  await close();
  await page.getByRole('button', { name: 'Show sidebar', exact: true }).click();
  await editor.focus();
  await editor.press('ControlOrMeta+z');
  await expect(editor).not.toContainText('preserve editor state');
  await expect(editor).toContainText('input{sections/body}');
  await editor.press('ControlOrMeta+f');
  await expect(page.locator('.cm-search')).toBeVisible();
  await editor.press('Escape');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByLabel('Appearance', { exact: true }).selectOption('system');
  await expect
    .poll(() => app.evaluate(({ nativeTheme }) => nativeTheme.themeSource))
    .toBe('system');
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.emulateMedia({ colorScheme: 'light' });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.getByLabel('Appearance', { exact: true }).selectOption('dark');
  await page.emulateMedia({ colorScheme: null });
  await expect.poll(() => app.evaluate(({ nativeTheme }) => nativeTheme.themeSource)).toBe('dark');
  await close();
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setContentSize(1040, 680),
  );
  await expect
    .poll(() =>
      page.locator('.editor-tab.active').evaluate((el) => {
        const r = el.getBoundingClientRect();
        const container = el.parentElement.getBoundingClientRect();
        return r.left >= container.left - 1 && r.right <= container.right + 1;
      }),
    )
    .toBe(true);
  await page.screenshot({ path: path.join(root, 'small-window.png') });
  const clipped = await page
    .locator(
      '.header-actions button, .editor-tools button, .preview-controls button, .sidebar-bottom button, .sidebar-bottom select',
    )
    .evaluateAll((elements) =>
      elements
        .filter((el) => {
          const r = el.getBoundingClientRect();
          if (!r.width || !r.height) return false;
          return (
            r.x < 0 ||
            r.y < 0 ||
            r.right > innerWidth + 1 ||
            r.bottom > innerHeight + 1 ||
            !el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2))
          );
        })
        .map((el) => el.getAttribute('aria-label') || el.textContent),
    );
  expect(clipped).toEqual([]);
  await page.getByRole('button', { name: 'More project actions', exact: true }).focus();
  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('menuitem', { name: 'Open project…', exact: true })).toBeFocused();
  await page.keyboard.press('End');
  await expect(page.getByRole('menuitem', { name: 'Settings', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(
    page.getByRole('button', { name: 'More project actions', exact: true }),
  ).toBeFocused();
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setContentSize(1480, 960),
  );
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Editor & PDF', exact: true }).click();
  await page.getByLabel('Editor text size', { exact: true }).selectOption('12');
  await close();
  console.log(
    'PASS: undo survives theme/sidebar changes, search, System theme, 18px text, small-window controls, and menu keyboard focus.',
  );

  for (const section of ['Experience', 'Education', 'Project', 'Skills']) {
    await editor.press('ControlOrMeta+End');
    await page.getByRole('button', { name: 'Insert a section', exact: true }).click();
    await page
      .getByRole('dialog')
      .getByRole('button', { name: new RegExp('^' + section) })
      .click();
    await expect(editor).toContainText(`section{${section === 'Project' ? 'Projects' : section}}`);
    await editor.press('ControlOrMeta+z');
    await expect(editor).not.toContainText(
      `section{${section === 'Project' ? 'Projects' : section}}`,
    );
  }
  await page.getByRole('button', { name: 'Hide sidebar', exact: true }).click();
  await menu('Add source file');
  await page.getByLabel('Filename', { exact: true }).fill('sections/added.tex');
  await page.getByRole('button', { name: 'Add file', exact: true }).click();
  await page.getByRole('button', { name: 'Show sidebar', exact: true }).click();
  await expect(page.getByRole('button', { name: 'sections/added.tex', exact: true })).toBeVisible();
  await menu('Help and keyboard shortcuts');
  await expect(page.getByRole('dialog')).toContainText('Find in source');
  await close();
  console.log('PASS: all section snippets, adding files with a hidden sidebar, and Help.');

  const saved = path.join(root, 'saved-copy');
  await fs.mkdir(saved);
  await choosePath(saved);
  await menu('Save project as…');
  await page.getByText('Saved locally', { exact: true }).waitFor();
  expect(await fs.readFile(path.join(saved, 'sections/added.tex'), 'utf8')).toContain(
    'sections/added.tex',
  );
  const archive = path.join(root, 'source.zip');
  await app.evaluate(({ dialog }, target) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: target });
  }, archive);
  await menu('Export LaTeX source…');
  await expect(page.getByRole('status')).toContainText('ZIP archive');
  const zip = unzipSync(await fs.readFile(archive));
  expect(strFromU8(zip['main.tex'])).toContain('input{sections/body}');
  expect(zip['notes/body.tex']).toBeTruthy();
  expect(zip['sections/added.tex']).toBeTruthy();
  await page.getByRole('button', { name: 'Recent projects', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('fixture');
  await close();
  await page.getByLabel('Project name', { exact: true }).fill('Unsaved rename');
  await menu('Open project…');
  await expect(page.getByRole('dialog')).toContainText('Keep your latest changes?');
  await page.getByRole('button', { name: 'Keep editing', exact: true }).click();
  await expect(page.getByLabel('Project name', { exact: true })).toHaveValue('Unsaved rename');
  console.log('PASS: Save As, source ZIP contents, recent projects, and unsaved-change guard.');

  for (let i = 0; i < templateCatalog.length; i++) {
    await page.getByRole('button', { name: 'Explore templates', exact: true }).click();
    await page.locator('.template-card').nth(i).click();
    if (await page.getByRole('button', { name: 'Discard changes', exact: true }).isVisible())
      await page.getByRole('button', { name: 'Discard changes', exact: true }).click();
    await page.getByRole('tab', { name: 'Code', exact: true }).click();
    await compile();
    await expect(page.locator('.preview-pane .pdf-sheet > canvas')).toHaveCount(1);
  }
  await editor.fill(
    '\\documentclass{article}\\begin{document}\\loop\\iftrue\\repeat\\end{document}',
  );
  await page.getByRole('button', { name: 'Compile', exact: true }).click();
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Compile', exact: true })).toBeEnabled();
  await expect(page.locator('.stale-note')).toBeVisible();
  expect(errors).toEqual([]);
  console.log('PASS: all templates, compile cancellation, stale preview, and no renderer errors.');
  console.log(`Evidence: ${root}`);
} finally {
  await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
  await app.close().catch(() => {});
}
