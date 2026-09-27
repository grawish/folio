import { _electron as electron, expect } from '@playwright/test';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

if (process.platform !== 'darwin' || process.arch !== 'arm64' || !process.argv[2])
  throw new Error('Provide a packaged Folio executable on an Apple silicon Mac.');
const executablePath = path.resolve(process.argv[2]);
const baseline = process.argv.includes('--baseline');
const legacyIndex = process.argv.indexOf('--legacy-app');
const legacyApp = legacyIndex < 0 ? undefined : path.resolve(process.argv[legacyIndex + 1]);
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const hash = async (file) => sha(await fs.readFile(file));
await fs.mkdir('test-results', { recursive: true });
const root = await fs.mkdtemp(path.resolve('test-results/preferences-'));
const data = path.join(root, 'data'),
  settingsFile = path.join(data, 'workspace-preferences.json');
const env = { ...process.env, FOLIO_USER_DATA: data };
delete env.ELECTRON_RUN_AS_NODE;
delete env.FOLIO_TEST_RUNTIME_SEED;
const resources = path.resolve(path.dirname(executablePath), '../Resources');
const result = {
  startedAt: new Date().toISOString(),
  sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  scriptSha256: await hash('scripts/test-preferences.mjs'),
  appAsarSha256: await hash(path.join(resources, 'app.asar')),
  runtimeManifestSha256: await hash(path.join(resources, 'runtime/manifest.json')),
  baseline,
  legacyApp,
  checks: [],
  events: [],
  errors: [],
  passed: false,
};
let app,
  page,
  output = '';
const record = (type, details = {}) =>
  result.events.push({ at: new Date().toISOString(), type, ...details });
async function launch(executable = executablePath, ready = true) {
  app = await electron.launch({ executablePath: executable, args: [], env, timeout: 60_000 });
  const child = app.process();
  record('launch', { pid: child.pid });
  child.on('exit', (code, signal) => record('exit', { pid: child.pid, code, signal }));
  for (const stream of [child.stdout, child.stderr])
    stream?.on('data', (bytes) => {
      output = (output + bytes.toString()).slice(-65_536);
    });
  page = await app.firstWindow();
  page.setDefaultTimeout(20_000);
  page.on('pageerror', (error) => result.errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') result.errors.push(message.text());
  });
  if (ready) {
    await expect(page.getByLabel('Message the resume agent')).toBeEnabled({ timeout: 120_000 });
    await expect(page.locator('.compiler-preparation')).toHaveCount(0, { timeout: 120_000 });
  }
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1480, 960));
}
async function close() {
  const closed = page.waitForEvent('close');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  await closed;
  await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
  await app.close().catch(() => {});
  app = undefined;
}
async function kill() {
  const child = app.process();
  const exited = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('The owned app did not exit.')), 10_000);
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
  expect(child.kill('SIGKILL')).toBe(true);
  expect((await exited).signal).toBe('SIGKILL');
  app = undefined;
}
const settings = () => page.getByRole('button', { name: 'Settings', exact: true }).click();
const done = async () => {
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  // Settings finishes native cancellation before closing its modal. Keyboard
  // input behind an open modal can be ignored without an automation error.
  await expect(page.locator('dialog[open]')).toHaveCount(0);
};
const code = () => page.getByRole('tab', { name: 'Code', exact: true }).click();
const auto = () => page.getByRole('checkbox', { name: 'Auto-compile', exact: true });
const read = async () => JSON.parse(await fs.readFile(settingsFile, 'utf8')).values;
const snapshot = () =>
  page.evaluate(() =>
    Object.fromEntries(
      ['folio:auto', 'folio:autosave', 'folio:font', 'folio:appearance', 'folio:panes'].map(
        (key) => [key, localStorage.getItem(key)],
      ),
    ),
  );
async function choose(light) {
  await code();
  await auto().uncheck();
  await settings();
  await page.getByRole('button', { name: 'General', exact: true }).click();
  await page.getByLabel('Appearance', { exact: true }).selectOption(light ? 'light' : 'dark');
  await page.getByLabel('Autosave project', { exact: true }).setChecked(light);
  await page.getByRole('button', { name: 'Editor & PDF', exact: true }).click();
  await page.getByLabel('Editor text size', { exact: true }).selectOption(light ? '18' : '12');
  await done();
  const previous = (await snapshot())['folio:panes'];
  for (const name of ['Resize file sidebar', 'Resize writing and PDF panes']) {
    const divider = page.getByRole('separator', { name });
    const before = Number(await divider.getAttribute('aria-valuenow'));
    const min = Number(await divider.getAttribute('aria-valuemin'));
    const max = Number(await divider.getAttribute('aria-valuemax'));
    const next = before === min ? max : min;
    expect(next).not.toBe(before);
    await divider.press(before === min ? 'End' : 'Home');
    await expect(divider).toHaveAttribute('aria-valuenow', String(next));
  }
  await expect.poll(async () => (await snapshot())['folio:panes']).not.toBe(previous);
  const expected = await snapshot();
  expect(expected['folio:auto']).toBe('false');
  expect(JSON.parse(expected['folio:panes']).sidebar).not.toBeNull();
  result.preferenceSnapshots ??= [];
  result.preferenceSnapshots.push(expected);
  return expected;
}
async function verify(expected) {
  await code();
  // First assertion is shared by the older-app control and the candidate.
  await expect(auto()).not.toBeChecked();
  await expect(page.locator('html')).toHaveAttribute('data-theme', expected['folio:appearance']);
  await settings();
  await page.getByRole('button', { name: 'General', exact: true }).click();
  await expect(page.getByLabel('Appearance', { exact: true })).toHaveValue(
    expected['folio:appearance'],
  );
  await expect(page.getByLabel('Autosave project', { exact: true })).toBeChecked({
    checked: expected['folio:autosave'] === 'true',
  });
  await page.getByRole('button', { name: 'Editor & PDF', exact: true }).click();
  await expect(page.getByLabel('Editor text size', { exact: true })).toHaveValue(
    expected['folio:font'],
  );
  await done();
  expect(await snapshot()).toEqual(expected);
  if (!baseline) expect(await read()).toEqual(expected);
}
try {
  if (legacyApp) {
    await launch(legacyApp);
    await page.getByText('Up to date', { exact: true }).waitFor({ timeout: 60_000 });
    const migrated = await choose(true);
    await close();
    await expect(fs.access(settingsFile)).rejects.toThrow();
    await launch();
    await verify(migrated);
    result.legacyMigration = {
      appAsarSha256: await hash(path.resolve(path.dirname(legacyApp), '../Resources/app.asar')),
      values: migrated,
    };
    result.checks.push(
      'An actual old-app Chromium profile migrated all five preferences; native storage was initially absent.',
    );
    await close();
  }
  await launch();
  if (!legacyApp) await page.getByText('Up to date', { exact: true }).waitFor({ timeout: 60_000 });
  for (const light of [true, false]) {
    const expected = await choose(light);
    if (!baseline) await expect.poll(read).toEqual(expected);
    await page.getByRole('tab', { name: 'Chat', exact: true }).click();
    const draft = `Retain this ${light ? 'first' : 'second'} preference crash draft.`;
    await page.getByLabel('Message the resume agent').fill(draft);
    const recovered = async () =>
      JSON.parse(await fs.readFile(path.join(data, 'recovery.json'), 'utf8')).project;
    await expect.poll(async () => (await recovered()).id).not.toBe('');
    const project = await recovered();
    await expect
      .poll(() =>
        page.evaluate((id) => window.folio.loadWorkspace(id).then((w) => w.draft), project.id),
      )
      .toBe(draft);
    await kill();
    await launch();
    await verify(expected);
    await page.getByRole('tab', { name: 'Chat', exact: true }).click();
    await expect(page.getByLabel('Message the resume agent')).toHaveValue(draft);
    result.checks.push(
      `All five ${light ? 'first' : 'second'} UI preferences and chat draft survived SIGKILL and reopen.`,
    );
  }
  if (!baseline) {
    const committed = await read();
    await app.evaluate((_, target) => {
      const io = process.getBuiltinModule('node:fs').promises;
      globalThis.preferencesRename = io.rename.bind(io);
      io.rename = async (from, to) => {
        if (to === target) throw new Error('Synthetic settings disk error');
        return globalThis.preferencesRename(from, to);
      };
    }, settingsFile);
    await settings();
    await page.getByRole('button', { name: 'General', exact: true }).click();
    await page.getByLabel('Appearance', { exact: true }).selectOption('light');
    await expect(page.getByRole('alert')).toContainText('Settings could not be saved');
    expect(await read()).toEqual(committed);
    await page.getByRole('button', { name: 'Editor & PDF', exact: true }).click();
    await page.getByLabel('Editor text size', { exact: true }).selectOption('16');
    await done();
    await page.screenshot({ path: path.join(root, 'save-error.png') });
    await app.evaluate(() => {
      process.getBuiltinModule('node:fs').promises.rename = globalThis.preferencesRename;
    });
    await page.getByRole('button', { name: 'Retry settings save', exact: true }).click();
    await expect(page.getByRole('alert')).toHaveCount(0);
    const retried = { ...committed, 'folio:appearance': 'light', 'folio:font': '16' };
    await expect.poll(read).toEqual(retried);
    result.checks.push(
      'An actual native write failure kept old disk values, surfaced an error and retried the latest pending controls.',
    );
    await close();
    const original = await fs.readFile(settingsFile),
      recoveryHash = await hash(path.join(data, 'recovery.json'));
    const damaged = '{"schema":"folio-preferences-unknown"}';
    await fs.writeFile(settingsFile, damaged);
    await launch(executablePath, false);
    await expect(page.getByRole('alert')).toContainText('Your settings could not be opened');
    await page.screenshot({ path: path.join(root, 'startup-error.png') });
    await close();
    expect(await fs.readFile(settingsFile, 'utf8')).toBe(damaged);
    expect(await hash(path.join(data, 'recovery.json'))).toBe(recoveryHash);
    await fs.writeFile(settingsFile, original);
    await launch();
    await verify(retried);
    await settings();
    await page.getByRole('button', { name: 'General', exact: true }).click();
    await page.screenshot({ path: path.join(root, 'recovered-settings.png') });
    await done();
    result.checks.push(
      'An unknown settings record stayed untouched; native close still worked before workspace startup, and source recovery remained byte-identical.',
    );
  }
  expect(result.errors).toEqual([]);
  expect(await hash(path.join(resources, 'app.asar'))).toBe(result.appAsarSha256);
  expect(await hash(path.join(resources, 'runtime/manifest.json'))).toBe(
    result.runtimeManifestSha256,
  );
  result.passed = true;
} catch (error) {
  result.error = error.stack ?? String(error);
  await page?.screenshot({ path: path.join(root, 'failure.png'), timeout: 5_000 }).catch(() => {});
  process.exitCode = 1;
} finally {
  if (app) {
    await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
    await app.close().catch(() => {});
  }
  result.finishedAt = new Date().toISOString();
  await fs.writeFile(path.join(root, 'result.json'), JSON.stringify(result, null, 2) + '\n');
  await fs.writeFile(path.join(root, 'native-output.log'), output);
  console.log(`Evidence: ${root}`);
  if (result.error) console.error(result.error);
}
