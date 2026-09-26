import { _electron as electron, expect } from '@playwright/test';
import { promises as fs } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate';
import { ProjectStore } from '../electron/core/project.ts';
import { fileDigest } from '../electron/core/save-transactions.ts';
import { WorkspaceStore } from '../electron/core/workspace.ts';
import { emptyWorkspace } from '../src/shared/ai.ts';

await fs.mkdir('test-results', { recursive: true });
const root = await fs.mkdtemp(path.resolve('test-results/save-recovery-'));
const projects = await fs.mkdtemp('/private/tmp/folio-recovery-demo-');
const data = path.join(root, 'data'),
  store = new ProjectStore(data),
  workspaces = new WorkspaceStore(data);
const errors = [],
  checks = [];
const source = (title) =>
  `\\documentclass{article}\n\\begin{document}\n\\section*{Jordan Lee}\n${title}\n\\input{section}\n\\end{document}\n`;
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXioAAAAASUVORK5CYII=',
  'base64',
);
async function interrupted(name, profile = false) {
  const directory = path.join(projects, name);
  await fs.mkdir(directory);
  await fs.writeFile(path.join(directory, 'main.tex'), source('Before the save'));
  await fs.writeFile(path.join(directory, 'section.tex'), 'Earlier experience details.');
  if (profile) await fs.writeFile(path.join(directory, 'retired.tex'), 'A retired section.');
  const project = await store.open(directory);
  await workspaces.save({ ...emptyWorkspace(project.id), draft: 'Saved conversation draft' });
  await store.save(project, undefined, false, (id) => workspaces.archive(id));
  if (profile) {
    await store.recover({
      ...project,
      revision: 9,
      files: project.files.map((file) => ({
        ...file,
        content: file.path === 'main.tex' ? source('Unsaved editor draft') : file.content,
      })),
    });
    await workspaces.save({ ...emptyWorkspace(project.id), draft: 'Unsaved conversation draft' });
  }
  const input = path.join(root, `changes-${project.id}.json`);
  await fs.writeFile(
    input,
    JSON.stringify([
      { path: 'main.tex', content: source('Attempted save') },
      { path: 'section.tex', content: 'Attempted experience details.' },
      ...(profile
        ? [
            {
              path: 'resume.folio',
              base64: Buffer.from(
                zipSync({
                  'state.json': strToU8(
                    JSON.stringify({
                      ...emptyWorkspace(project.id),
                      draft: 'Attempted conversation draft',
                    }),
                  ),
                }),
              ).toString('base64'),
            },
            { path: 'assets/mark.png', base64: png.toString('base64') },
            { path: 'retired.tex', content: null },
          ]
        : []),
    ]),
  );
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', 'tests/fixtures/save-crash.ts', data, directory, input, 'applying'],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let output = '',
    stderr = '';
  child.stdout.on('data', (bytes) => {
    output += bytes;
    if (output.includes('READY-TO-KILL')) child.kill('SIGKILL');
  });
  child.stderr.on('data', (bytes) => {
    stderr += bytes;
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('Crash fixture timeout: ' + stderr));
    }, 20_000);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (_code, signal) => {
      clearTimeout(timer);
      if (signal === 'SIGKILL' && output.includes('READY-TO-KILL')) resolve();
      else reject(new Error(stderr));
    });
  });
  await fs.writeFile(path.join(directory, 'main.tex'), source('Outside edit after interruption'));
  return { directory, project, id: fileDigest(directory) };
}
const first = await interrupted('Resume review', true);
const originalRecovery = await fs.readFile(path.join(data, 'recovery.json'));
const env = { ...process.env, FOLIO_USER_DATA: data };
delete env.ELECTRON_RUN_AS_NODE;
if (process.env.FOLIO_TEST_RUNTIME_SEED)
  await fs.cp(path.resolve(process.env.FOLIO_TEST_RUNTIME_SEED), path.join(data, 'runtimes'), {
    recursive: true,
  });
let app, page;
async function launch() {
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
  await app.evaluate(({ shell }) => {
    globalThis.recoveryReveals = [];
    shell.showItemInFolder = (filename) => globalThis.recoveryReveals.push(filename);
  });
}
const startupReview = async () => {
  await page
    .getByRole('button', { name: 'Review interrupted saves', exact: true })
    .click({ timeout: 120_000 });
  await expect(page.getByRole('button', { name: 'Review files', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Review files', exact: true }).click();
  await expect(page.locator('.save-recovery-code')).toContainText(
    'Outside edit after interruption',
  );
};
const file = async (filename) =>
  page
    .getByRole('navigation', { name: 'Recovery files' })
    .getByRole('button')
    .filter({ has: page.locator('strong', { hasText: filename }) })
    .click();
const apply = async () => {
  await page.getByRole('button', { name: 'Review choices', exact: true }).click();
  await page.getByRole('button', { name: 'Apply and keep backups', exact: true }).click();
};
const menuReview = async () => {
  await page.getByRole('button', { name: 'More project actions', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Interrupted saves…', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Review files', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Review files', exact: true }).click();
};
async function holdApply(directory) {
  await app.evaluate((_, directory) => {
    const fs = process.getBuiltinModule('node:fs').promises,
      nativeRename = fs.rename.bind(fs);
    globalThis.recoveryHeld = false;
    fs.rename = async (from, to) => {
      if (to === directory + '/main.tex' && String(from).includes('.recover-')) {
        globalThis.recoveryHeld = true;
        await new Promise((resolve) => {
          globalThis.releaseRecovery = resolve;
        });
      }
      return nativeRename(from, to);
    };
  }, directory);
}
try {
  await launch();
  await startupReview();
  expect((await fs.readFile(path.join(data, 'recovery.json'))).equals(originalRecovery)).toBe(true);
  await expect(
    page.getByRole('radio', { name: 'Keep Current disk copy for main.tex', exact: true }),
  ).toBeChecked();
  for (const [version, text] of [
    ['Before the save', 'Before the save'],
    ['Attempted save', 'Attempted save'],
    ['Current disk copy', 'Outside edit after interruption'],
  ]) {
    await page.getByRole('button', { name: version, exact: true }).click();
    await expect(page.locator('.save-recovery-code')).toContainText(text);
  }
  await page.getByRole('button', { name: 'Show copies', exact: true }).click();
  expect(await app.evaluate(() => globalThis.recoveryReveals)).toEqual([
    path.join(data, 'save-transactions', first.id),
  ]);
  const blocked = await page.evaluate(
    async (project) =>
      window.folio.autosaveProject(project).then(
        () => '',
        (error) => error.message,
      ),
    first.project,
  );
  expect(blocked).toContain('Close save recovery');
  const blockedPickers = await page.evaluate(async () =>
    Promise.all(
      [
        window.folio.openProject(),
        window.folio.openFolder(),
        window.folio.prepareImport(),
        window.folio.resumeImport('synthetic-id'),
        window.folio.discardImport('synthetic-id'),
      ].map((operation) =>
        operation.then(
          () => '',
          (error) => error.message,
        ),
      ),
    ),
  );
  for (const message of blockedPickers) expect(message).toContain('Close save recovery');

  await page.screenshot({ path: path.join(root, 'review-dark.png') });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1040, 680));
  for (const name of ['Close', 'Review choices', 'Refresh']) {
    const button = page.getByRole('button', { name, exact: true });
    await expect(button).toBeInViewport();
    expect(
      await button.evaluate((node) => {
        const r = node.getBoundingClientRect();
        return node.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
      }),
    ).toBe(true);
  }
  await page.screenshot({ path: path.join(root, 'review-dark-small.png') });
  await page.evaluate(() => localStorage.setItem('folio:appearance', 'light'));
  await page.reload();
  await startupReview();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.screenshot({ path: path.join(root, 'review-light-small.png') });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1480, 960));
  await page.screenshot({ path: path.join(root, 'review-light.png') });
  checks.push(
    'failed startup exposes real before/attempted/current copies; default preserves outside edit; compact controls work in both themes; reload releases abandoned review',
  );
  await fs.writeFile(path.join(first.directory, 'section.tex'), 'Newer edit during review.');
  await apply();
  await expect(page.locator('.save-recovery-body [role="alert"]')).toContainText('changed');
  expect(await fs.readFile(path.join(first.directory, 'main.tex'), 'utf8')).toBe(
    source('Outside edit after interruption'),
  );
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Review choices', exact: true })).toBeEnabled();
  await page.getByRole('radio', { name: 'Keep Before the save for main.tex', exact: true }).check();
  await file('section.tex');
  await page
    .getByRole('radio', { name: 'Keep Before the save for section.tex', exact: true })
    .check();
  for (const filename of ['resume.folio', 'assets/mark.png', 'retired.tex']) {
    await file(filename);
    await page
      .getByRole('radio', { name: `Keep Attempted save for ${filename}`, exact: true })
      .check();
    if (filename !== 'retired.tex')
      await expect(page.locator('.save-recovery-code')).toContainText('binary file');
    else await expect(page.locator('.save-recovery-code')).toContainText('leaves this file absent');
  }
  await apply();
  await expect(page.getByText('Ready to reopen your project', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Show recovery copies', exact: true }).click();
  const copies = (await app.evaluate(() => globalThis.recoveryReveals)).at(-1);
  const draftDirectory = (await fs.readdir(copies)).find((name) =>
    /^draft-[a-f0-9]{24}$/.test(name),
  );
  expect(await fs.readFile(path.join(copies, draftDirectory, 'main.tex'), 'utf8')).toBe(
    source('Unsaved editor draft'),
  );
  expect(
    await fs.readFile(path.join(copies, 'kept-' + fileDigest('Newer edit during review.')), 'utf8'),
  ).toBe('Newer edit during review.');
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(page.getByLabel('Message the resume agent')).toHaveValue(
    'Attempted conversation draft',
  );
  await expect(page.locator('.preview-pane .textLayer')).toContainText('Before the save', {
    timeout: 60_000,
  });
  expect(await fs.readFile(path.join(first.directory, 'main.tex'), 'utf8')).toBe(
    source('Before the save'),
  );
  checks.push(
    'stale review changes no files; refreshed choices preserve newer outside edit and editor/conversation drafts; chosen files reopen and compile',
  );
  expect((await fs.readFile(path.join(first.directory, 'assets/mark.png'))).equals(png)).toBe(true);
  await expect
    .poll(() =>
      fs.access(path.join(first.directory, 'retired.tex')).then(
        () => true,
        () => false,
      ),
    )
    .toBe(false);
  const exportFile = path.join(root, 'recovered-source.zip');
  await app.evaluate(({ dialog }, filename) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: filename });
  }, exportFile);
  const chosenProject = await new ProjectStore(data).open(first.directory);
  expect(await page.evaluate((project) => window.folio.exportSource(project), chosenProject)).toBe(
    true,
  );
  const exported = unzipSync(await fs.readFile(exportFile));
  expect(Buffer.from(exported['assets/mark.png']).equals(png)).toBe(true);
  expect(strFromU8(exported['main.tex'])).toBe(source('Before the save'));
  expect(exported['retired.tex']).toBeUndefined();
  expect(JSON.parse(strFromU8(unzipSync(exported['resume.folio'])['state.json'])).draft).toBe(
    'Attempted conversation draft',
  );
  checks.push(
    'binary/history choices, source deletion and new asset apply exactly; selected source, asset and conversation round-trip in ZIP export',
  );

  const second = await interrupted('Damaged backup');
  await fs.writeFile(
    path.join(data, 'save-transactions', second.id, 'old-0'),
    'Damaged original copy',
  );
  await page.getByRole('tab', { name: 'Code', exact: true }).click();
  await page.getByLabel('Auto-compile', { exact: true }).uncheck();
  await page.locator('.cm-content').fill(source('Unfinished source from another project'));
  await page.getByRole('tab', { name: 'Chat', exact: true }).click();
  await page.getByLabel('Message the resume agent').fill('Another unfinished conversation');
  await menuReview();
  await expect(
    page.getByRole('radio', { name: 'Keep Before the save for main.tex', exact: true }),
  ).toBeDisabled();
  await page.getByRole('radio', { name: 'Keep Attempted save for main.tex', exact: true }).check();
  await holdApply(second.directory);
  await apply();
  await expect.poll(() => app.evaluate(() => globalThis.recoveryHeld)).toBe(true);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  expect(page.isClosed()).toBe(false);
  const closed = page.waitForEvent('close');
  await app.evaluate(() => globalThis.releaseRecovery());
  await closed;
  await app.close();
  await launch();
  await expect(page.getByLabel('Message the resume agent')).toHaveValue(
    'Saved conversation draft',
    { timeout: 120_000 },
  );
  await expect(page.getByLabel('Project name')).toHaveValue('Damaged backup');
  expect(await fs.readFile(path.join(second.directory, 'main.tex'), 'utf8')).toBe(
    source('Attempted save'),
  );
  expect(await fs.readFile(path.join(first.directory, 'main.tex'), 'utf8')).toBe(
    source('Before the save'),
  );
  const archiveNames = await fs.readdir(path.join(data, 'save-recovery-copies'));
  const secondArchive = (
    await Promise.all(
      archiveNames.map(async (name) => ({
        name,
        journal: JSON.parse(
          await fs.readFile(path.join(data, 'save-recovery-copies', name, 'journal.json'), 'utf8'),
        ),
      })),
    )
  ).find((entry) => entry.journal.root === second.directory);
  const secondCopies = path.join(data, 'save-recovery-copies', secondArchive.name);
  expect(await fs.readFile(path.join(secondCopies, 'old-0'), 'utf8')).toBe('Damaged original copy');
  const secondDraft = (await fs.readdir(secondCopies)).find((name) =>
    /^draft-[a-f0-9]{24}$/.test(name),
  );
  expect(await fs.readFile(path.join(secondCopies, secondDraft, 'main.tex'), 'utf8')).toBe(
    source('Unfinished source from another project'),
  );
  checks.push(
    'normal project menu supports damaged backups; native close waits for Apply; reopening uses chosen project; another project’s unsaved source is retained without overwriting its folder',
  );
  const third = await interrupted('Reload during recovery');
  await menuReview();
  await page.getByRole('radio', { name: 'Keep Before the save for main.tex', exact: true }).check();
  await holdApply(third.directory);
  await apply();
  await expect.poll(() => app.evaluate(() => globalThis.recoveryHeld)).toBe(true);
  await page.reload();
  await expect(page.getByText('Preparing your workspace', { exact: true })).toBeVisible();
  await app.evaluate(() => globalThis.releaseRecovery());
  await expect(page.getByLabel('Project name')).toHaveValue('Reload during recovery', {
    timeout: 60_000,
  });
  await expect(page.getByLabel('Message the resume agent')).toHaveValue('Saved conversation draft');
  expect(await fs.readFile(path.join(third.directory, 'main.tex'), 'utf8')).toBe(
    source('Before the save'),
  );
  await page.getByRole('button', { name: 'More project actions', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Interrupted saves…', exact: true }).click();
  await expect(page.getByText('No interrupted saves to review.', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Show all recovery copies', exact: true }).click();
  expect((await app.evaluate(() => globalThis.recoveryReveals)).at(-1)).toBe(
    path.join(data, 'save-recovery-copies'),
  );
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  checks.push(
    'reload during Apply waits and opens chosen files/history; completed copies remain accessible after the review is closed',
  );
  const fourth = await interrupted('Retry a stopped recovery');
  await page.getByRole('tab', { name: 'Code', exact: true }).click();
  await page.locator('.cm-content').fill(source('Unsaved before failed Apply'));
  await page.getByRole('tab', { name: 'Chat', exact: true }).click();
  await menuReview();
  await page.getByRole('radio', { name: 'Keep Before the save for main.tex', exact: true }).check();
  await app.evaluate((_, directory) => {
    const fs = process.getBuiltinModule('node:fs').promises,
      original = fs.rename.bind(fs);
    let failed = false;
    fs.rename = async (from, to) => {
      if (!failed && to === directory + '/section.tex' && String(from).includes('.recover-')) {
        failed = true;
        throw new Error('Synthetic stopped recovery write');
      }
      return original(from, to);
    };
  }, fourth.directory);
  await apply();
  await expect(page.locator('.save-recovery-body [role="alert"]')).toContainText(
    'Synthetic stopped recovery write',
  );
  expect(await fs.readFile(path.join(fourth.directory, 'main.tex'), 'utf8')).toBe(
    source('Before the save'),
  );
  expect(await fs.readFile(path.join(fourth.directory, 'section.tex'), 'utf8')).toBe(
    'Attempted experience details.',
  );
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(page.getByLabel('Project name')).toHaveValue('Retry a stopped recovery', {
    timeout: 60_000,
  });
  await expect(page.getByLabel('Message the resume agent')).toHaveValue('Saved conversation draft');
  expect(await fs.readFile(path.join(fourth.directory, 'main.tex'), 'utf8')).toBe(
    source('Before the save'),
  );
  expect(await fs.readFile(path.join(fourth.directory, 'section.tex'), 'utf8')).toBe(
    'Earlier experience details.',
  );
  checks.push(
    'dismissing a failed partial Apply re-enters recovery; an old editor buffer cannot erase the pending choices',
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
  await app?.evaluate(({ app }) => app.exit(0)).catch(() => {});
  await app?.close().catch(() => {});
}
