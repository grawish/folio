import { _electron as electron, expect } from '@playwright/test';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { unzipSync } from 'fflate';

const root = await fs.mkdtemp(path.resolve('test-results/workspace-'));
const folder = path.join(root, 'project');
await fs.mkdir(folder);
const env = { ...process.env, FOLIO_USER_DATA: path.join(root, 'data') };
delete env.ELECTRON_RUN_AS_NODE;
let app, page;
const errors = [];
const layouts = [];
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const readSource = () => fs.readFile(path.join(folder, 'main.tex'), 'utf8');
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
  if (await page.evaluate(() => localStorage.getItem('folio:auto') === 'false')) {
    await page.getByRole('tab', { name: 'Code', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Compile', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: 'Compile', exact: true }).click();
    await page.getByRole('tab', { name: 'Chat', exact: true }).click();
  }
  await page.getByText('Up to date', { exact: true }).waitFor({ timeout: 60_000 });
};
const settings = () => page.getByRole('button', { name: 'Settings', exact: true }).click();
const done = () => page.getByRole('button', { name: 'Done', exact: true }).click();
const code = () => page.getByRole('tab', { name: 'Code', exact: true }).click();
const editor = () => page.locator('.cm-content');
const separator = () => page.getByRole('separator', { name: 'Resize writing and PDF panes' });
const width = (selector) =>
  page.locator(selector).evaluate((node) => node.getBoundingClientRect().width);
const captureLayout = async (phase) => {
  const native = await app.evaluate(({ BrowserWindow, screen }) => ({
    bounds: BrowserWindow.getAllWindows()[0].getBounds(),
    contentBounds: BrowserWindow.getAllWindows()[0].getContentBounds(),
    displays: screen.getAllDisplays().map(({ bounds, workArea, scaleFactor }) => ({
      bounds,
      workArea,
      scaleFactor,
    })),
  }));
  const layout = {
    phase,
    native,
    viewport: await page.evaluate(() => ({ width: innerWidth, height: innerHeight })),
    editor: await width('.editor-pane'),
    preview: await width('.preview-pane'),
    min: Number(await separator().getAttribute('aria-valuemin')),
    max: Number(await separator().getAttribute('aria-valuemax')),
  };
  layouts.push(layout);
  await fs.writeFile(path.join(root, 'layout-measurements.json'), JSON.stringify(layouts, null, 2));
  return layout;
};
const dragWritingPane = async (delta, phase) => {
  const before = await captureLayout(`${phase}:before`);
  const handle = await separator().boundingBox();
  const x = handle.x + handle.width / 2;
  const y = handle.y + Math.min(140, handle.height / 2);
  // A small native display can constrain the initial window to its minimum.
  // Exercise real pointer movement and the advertised bounds at any such size.
  const expected = Math.min(before.max, Math.max(before.min, before.editor + delta));
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + delta, y, { steps: 8 });
  await page.mouse.up();
  await expect.poll(() => width('.editor-pane')).toBeCloseTo(expected, 0);
  const after = await captureLayout(`${phase}:after`);
  expect(after.editor).toBeGreaterThanOrEqual(359);
  expect(after.preview).toBeGreaterThanOrEqual(419);
  return { before, after };
};
const closed = async () => {
  const event = page.waitForEvent('close');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  await event;
  await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
  await app.close().catch(() => {});
};
const holdNextSourceWrite = (fail = false) =>
  app.evaluate(
    async (_, { target, fail }) => {
      const fs = process.getBuiltinModule('node:fs');
      const original = fs.promises.rename;
      fs.promises.rename = async (...args) => {
        if (args[1] === target) {
          fs.promises.rename = original;
          globalThis.writeHeld = true;
          await new Promise((resolve) => {
            globalThis.releaseWrite = resolve;
          });
          if (fail) throw new Error('Synthetic autosave write failure');
        }
        return original(...args);
      };
      globalThis.writeHeld = false;
    },
    { target: path.join(folder, 'main.tex'), fail },
  );
try {
  await launch();
  await app.evaluate(({ dialog }) => {
    dialog.openCount = 0;
    dialog.conflictCount = 0;
    dialog.showOpenDialog = async () => {
      dialog.openCount++;
      return { canceled: true, filePaths: [] };
    };
    dialog.showMessageBox = async () => {
      dialog.conflictCount++;
      return { response: 0 };
    };
  });
  await settings();
  await expect(page.getByLabel('Autosave project', { exact: true })).not.toBeChecked();
  await page.getByLabel('Autosave project', { exact: true }).check();
  await done();
  await code();
  await page.getByLabel('Auto-compile', { exact: true }).uncheck();
  // CodeMirror virtualizes long sources: its visible DOM is not the whole file.
  const original = await fs.readFile('resources/templates/classic.tex', 'utf8');
  await editor().press('ControlOrMeta+End');
  await page.keyboard.insertText('\n% Untitled edit');
  await pause(2600);
  expect(await app.evaluate(({ dialog }) => dialog.openCount)).toBe(0);
  expect((await fs.readdir(folder)).length).toBe(0);
  const nativeDraft = JSON.parse(
    await fs.readFile(path.join(root, 'data/recovery.json'), 'utf8'),
  ).project;
  expect(nativeDraft.files.find((file) => file.path === 'main.tex').content).toContain(
    '% Untitled edit',
  );
  expect(
    (await page.evaluate((project) => window.folio.autosaveProject(project), nativeDraft)).saved,
  ).toBe(false);
  expect(await app.evaluate(({ dialog }) => dialog.openCount)).toBe(0);
  console.log(
    'PASS: autosave defaults off, untitled projects keep recovery without folder prompts.',
  );

  await dragWritingPane(100, 'initial-right');
  const left = await dragWritingPane(-100, 'initial-left');
  expect(left.before.editor - left.after.editor).toBeGreaterThan(60);
  await editor().focus();
  await editor().press('ControlOrMeta+z');
  // Verify the full recovered buffer, including text outside CodeMirror's
  // virtualized viewport. At the minimum size the name can be off-screen.
  await expect
    .poll(async () => {
      const recovery = JSON.parse(await fs.readFile(path.join(root, 'data/recovery.json'), 'utf8'));
      return recovery.project.files.find((file) => file.path === 'main.tex').content;
    })
    .toBe(original);
  await page.getByRole('separator', { name: 'Resize file sidebar' }).focus();
  await page.keyboard.press('Shift+ArrowRight');
  const preferred = await page.evaluate(() => localStorage.getItem('folio:panes'));
  await page.getByRole('button', { name: 'Hide sidebar', exact: true }).click();
  await page.getByRole('button', { name: 'Show sidebar', exact: true }).click();
  expect(await page.evaluate(() => localStorage.getItem('folio:panes'))).toBe(preferred);
  for (const size of [
    [1480, 960],
    [1040, 680],
  ]) {
    await app.evaluate(
      ({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setSize(...size),
      size,
    );
    await expect.poll(() => page.evaluate(() => innerWidth)).toBe(size[0]);
    await separator().press('Enter');
    await dragWritingPane(100, `requested-${size.join('x')}-right`);
    await dragWritingPane(-100, `requested-${size.join('x')}-left`);
    for (const key of ['Home', 'End']) {
      await separator().focus();
      await page.keyboard.press(key);
      expect(await width('.editor-pane')).toBeGreaterThanOrEqual(359);
      expect(await width('.preview-pane')).toBeGreaterThanOrEqual(419);
      const clipped = await page
        .locator('.editor-tools button, .preview-controls button, .workspace-tabs button')
        .evaluateAll((nodes) =>
          nodes
            .filter((node) => {
              const r = node.getBoundingClientRect();
              return (
                r.width &&
                r.height &&
                (r.right > innerWidth ||
                  !node.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)))
              );
            })
            .map((node) => node.getAttribute('aria-label') || node.textContent),
        );
      expect(clipped).toEqual([]);
    }
  }
  await separator().press('Enter');
  await page.getByRole('tab', { name: 'Chat', exact: true }).click();
  await page.screenshot({ path: path.join(root, 'resized-small-dark.png') });
  await settings();
  await page.screenshot({ path: path.join(root, 'settings-small-dark.png') });
  await page.getByRole('button', { name: 'Reset pane sizes', exact: true }).click();
  await done();
  await page.getByRole('separator', { name: 'Resize file sidebar' }).press('ArrowRight');
  const persisted = await page.evaluate(() => localStorage.getItem('folio:panes'));
  console.log(
    'PASS: drag/keyboard/reset, minimum sizes, usable controls, sidebar toggle and editor undo.',
  );

  await app.evaluate(({ dialog }, folder) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] });
  }, folder);
  await page.getByRole('button', { name: 'Save project', exact: true }).click();
  await page.getByText('Saved locally', { exact: true }).waitFor();
  await code();
  await editor().fill(original + '\n% Autosaved source');
  await expect.poll(readSource, { timeout: 15_000 }).toContain('Autosaved source');
  await page.getByText('Saved locally', { exact: true }).waitFor();
  await page.getByRole('tab', { name: 'Chat', exact: true }).click();
  await page.getByLabel('Message the resume agent').fill('Keep this draft in the project folder.');
  await expect
    .poll(async () => {
      const zip = unzipSync(await fs.readFile(path.join(folder, 'resume.folio')));
      return JSON.parse(Buffer.from(zip['state.json']).toString()).draft;
    })
    .toBe('Keep this draft in the project folder.');
  await code();
  await holdNextSourceWrite();
  await editor().fill(original + '\n% First snapshot');
  await expect.poll(() => app.evaluate(() => globalThis.writeHeld)).toBe(true);
  await editor().fill(original + '\n% Newer typing');
  await app.evaluate(() => globalThis.releaseWrite());
  await expect.poll(readSource).toContain('Newer typing');
  await expect(editor()).toContainText('Newer typing');
  console.log('PASS: source and chat autosave, typing during a save remains dirty and saves next.');

  const baseline = await readSource();
  const external = original + '\n% External version';
  await fs.writeFile(path.join(folder, 'main.tex'), external);
  await page.getByRole('region', { name: 'External file changes' }).waitFor();
  await editor().fill(original + '\n% Retained editor version');
  await pause(2700);
  expect(await readSource()).toBe(external);
  await expect(page.getByText('Autosave paused', { exact: true })).toBeVisible();
  expect(await app.evaluate(({ dialog }) => dialog.conflictCount)).toBe(0);
  const warningBounds = await page.locator('.stale-note').boundingBox();
  const annotationBounds = await page
    .getByRole('toolbar', { name: 'PDF annotation tools' })
    .boundingBox();
  expect(annotationBounds.y).toBeGreaterThanOrEqual(warningBounds.y + warningBounds.height);
  await page.screenshot({ path: path.join(root, 'autosave-paused-dark.png') });
  // Call the actual background IPC too: it must refuse even without renderer suppression.
  const project = JSON.parse(
    await fs.readFile(path.join(root, 'data/recovery.json'), 'utf8'),
  ).project;
  expect((await page.evaluate((p) => window.folio.autosaveProject(p), project)).conflict).toBe(
    true,
  );
  expect(await app.evaluate(({ dialog }) => dialog.conflictCount)).toBe(0);
  await fs.writeFile(path.join(folder, 'main.tex'), baseline);
  await expect(page.getByRole('region', { name: 'External file changes' })).toHaveCount(0);
  await expect.poll(readSource).toContain('Retained editor version');
  console.log(
    'PASS: external edits pause autosave; background IPC refuses conflicts without an overwrite dialog.',
  );

  // A failed write must still recover text typed while the transaction was held.
  await holdNextSourceWrite(true);
  const beforeFailure = await readSource();
  await editor().fill(original + '\n% Earlier failed snapshot');
  await expect.poll(() => app.evaluate(() => globalThis.writeHeld)).toBe(true);
  await editor().fill(original + '\n% Retry after failure');
  await pause(750);
  await app.evaluate(() => globalThis.releaseWrite());
  await page.getByRole('button', { name: 'Save to retry', exact: true }).waitFor();
  await pause(2700);
  expect(await readSource()).toBe(beforeFailure);
  const recoveredAfterFailure = JSON.parse(
    await fs.readFile(path.join(root, 'data/recovery.json'), 'utf8'),
  );
  expect(recoveredAfterFailure.project.files[0].content).toContain('Retry after failure');
  await expect(editor()).toContainText('Retry after failure');
  await page.getByRole('button', { name: 'Save to retry', exact: true }).click();
  await expect.poll(readSource).toContain('Retry after failure');
  await expect(page.getByRole('button', { name: 'Save to retry', exact: true })).toHaveCount(0);
  console.log('PASS: failed writes roll back and pause; explicit Save resumes autosave.');

  const beforeSwitch = await readSource();
  await app.evaluate(({ dialog }) => {
    dialog.finishPendingOpen = null;
    dialog.showOpenDialog = () =>
      new Promise((resolve) => {
        dialog.finishPendingOpen = resolve;
      });
  });
  await editor().fill(original + '\n% Pending project switch');
  await page.getByRole('button', { name: 'Open project', exact: true }).click();
  await page.getByRole('button', { name: 'Discard changes', exact: true }).click();
  await expect.poll(() => app.evaluate(({ dialog }) => !!dialog.finishPendingOpen)).toBe(true);
  await pause(2700);
  expect(await readSource()).toBe(beforeSwitch);
  await app.evaluate(({ dialog }) => dialog.finishPendingOpen({ canceled: true, filePaths: [] }));
  await expect.poll(readSource).toContain('Pending project switch');
  console.log('PASS: choosing another project suspends autosave through the native file dialog.');

  await holdNextSourceWrite();
  await editor().fill(original + '\n% Close during autosave');
  await expect.poll(() => app.evaluate(() => globalThis.writeHeld)).toBe(true);
  const closeEvent = page.waitForEvent('close');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  expect(page.isClosed()).toBe(false);
  await app.evaluate(() => globalThis.releaseWrite());
  await closeEvent;
  await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
  await app.close().catch(() => {});
  expect(await readSource()).toContain('Close during autosave');
  await launch();
  expect(await page.evaluate(() => localStorage.getItem('folio:panes'))).toBe(persisted);
  await settings();
  await expect(page.getByLabel('Autosave project', { exact: true })).toBeChecked();
  await page.getByLabel('Appearance', { exact: true }).selectOption('light');
  await page.getByLabel('Autosave project', { exact: true }).uncheck();
  await page.screenshot({ path: path.join(root, 'settings-light.png') });
  await done();
  await code();
  await editor().press('ControlOrMeta+End');
  await expect(editor()).toContainText('Close during autosave');
  await editor().fill(original + '\n% Disabled autosave');
  await pause(2700);
  expect(await readSource()).toContain('Close during autosave');
  await closed();
  await launch();
  await settings();
  await expect(page.getByLabel('Autosave project', { exact: true })).not.toBeChecked();
  await done();
  await code();
  await editor().press('ControlOrMeta+End');
  await expect(editor()).toContainText('Disabled autosave');
  expect(errors).toEqual([]);
  await fs.writeFile(
    path.join(root, 'result.json'),
    JSON.stringify({ passed: true, errors }, null, 2),
  );
  console.log(
    `PASS: close waits for autosave; source, disabled recovery and preferences survive restart. No renderer errors.\nEvidence: ${root}`,
  );
} catch (error) {
  await page?.screenshot({ path: path.join(root, 'failure.png') }).catch(() => {});
  console.error(`Evidence: ${root}`);
  throw error;
} finally {
  await app?.evaluate(({ app }) => app.exit(0)).catch(() => {});
  await app?.close().catch(() => {});
}
