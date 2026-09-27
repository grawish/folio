import { _electron as electron, expect } from '@playwright/test';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Drives the same git:* IPC channels the renderer uses (via window.folio),
// against a synthetic project directory. No network, no user files/accounts.
// Uses the OS temp dir (not test-results/, which lives inside this repo's own
// .git worktree) so `git rev-parse` inside the fixture can't walk up into it.
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'folio-git-smoke-'));
const directory = path.join(root, 'project');
const dataRoot = path.join(root, 'app-data');
await fs.mkdir(directory, { recursive: true });
const projectId = 'git-smoke-project';
const main = String.raw`\documentclass{article}
\begin{document}
\section*{Git Smoke Test}
A document for exercising the git IPC surface end to end.
\end{document}`;
await fs.writeFile(path.join(directory, 'main.tex'), main);
// Fixing the project id in the manifest lets the harness call window.folio.git*
// without first scraping renderer state for whatever id ProjectStore assigned.
await fs.writeFile(
  path.join(directory, 'resume.project.json'),
  JSON.stringify({ schemaVersion: 2, id: projectId, revision: 0, name: 'Git Smoke', mainFile: 'main.tex' }, null, 2),
);
const env = { ...process.env, FOLIO_USER_DATA: dataRoot };
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
  await expect(page.locator('.compiler-preparation')).toHaveCount(0, { timeout: 120_000 });
};
const chooseFolder = (folder) =>
  app.evaluate(({ dialog }, folder) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] });
  }, folder);
const action = async (label) => {
  await page.getByRole('button', { name: 'More project actions' }).click();
  await page.getByRole('menuitem', { name: label, exact: true }).click();
};
// Runs an IPC call in the renderer, the same surface GitPanel uses.
const gitCall = (method, ...args) =>
  page.evaluate(
    ({ method, args }) => window.folio[method](...args),
    { method, args },
  );

try {
  await launch();
  await chooseFolder(directory);
  await action('Open project folder…');
  // Git IPC only needs the project open, not a finished LaTeX compile, so
  // assert on the Code editor (loads immediately) rather than waiting on the
  // PDF preview or 'Up to date', which can take minutes on a cold profile.
  await page.getByRole('tab', { name: 'Code', exact: true }).click();
  await expect(page.locator('.cm-content')).toContainText('Git Smoke Test', { timeout: 30_000 });

  const availability = await gitCall('gitAvailability', projectId);
  expect(availability.installed).toBe(true);
  console.log('PASS: git availability reports an installed git binary.');

  expect(await gitCall('gitStatus', projectId)).toBeNull();
  const initStatus = await gitCall('gitInit', projectId);
  expect(initStatus.state).toBe('clean');
  expect(await fs.stat(path.join(directory, '.git')).then((s) => s.isDirectory())).toBe(true);
  console.log('PASS: gitInit creates a real .git directory and status reflects a clean repo.');

  await fs.writeFile(path.join(directory, 'main.tex'), main + '\n% tracked change\n');
  const dirtyStatus = await gitCall('gitStatus', projectId);
  const trackedRow = dirtyStatus.files.find((f) => f.path === 'main.tex');
  expect(trackedRow).toMatchObject({ staged: null, unstaged: 'untracked' });
  console.log('PASS: an on-disk edit under a fresh repo shows up as untracked via git:status.');

  const stagedStatus = await gitCall('gitStage', projectId, ['main.tex']);
  expect(stagedStatus.files.find((f) => f.path === 'main.tex')).toMatchObject({
    staged: 'added',
    unstaged: null,
  });
  console.log('PASS: git:stage stages the working-tree file.');

  const commitStatus = await gitCall('gitCommit', projectId, 'Initial commit from smoke test');
  expect(commitStatus.files.find((f) => f.path === 'main.tex')).toBeUndefined();
  const log = await gitCall('gitLog', projectId, { limit: 10 });
  expect(log).toHaveLength(1);
  expect(log[0].subject).toBe('Initial commit from smoke test');
  console.log('PASS: git:commit records the message and git:log returns it newest-first.');

  expect(errors, errors.join('\n')).toEqual([]);
  await fs.writeFile(path.join(root, 'result.json'), JSON.stringify({ passed: true, errors }, null, 2));
  console.log(`Evidence: ${root}`);
} finally {
  await app?.evaluate(({ app }) => app.exit(0)).catch(() => {});
  await app?.close().catch(() => {});
}
