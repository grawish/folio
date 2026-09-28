import { _electron as electron, expect } from '@playwright/test';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

if (process.platform !== 'darwin' || process.arch !== 'arm64' || !process.argv[2])
  throw new Error('Provide a packaged Folio executable on an Apple silicon Mac.');
const executablePath = path.resolve(process.argv[2]);
const resources = path.resolve(path.dirname(executablePath), '../Resources');
const hash = async (file) =>
  createHash('sha256')
    .update(await fs.readFile(file))
    .digest('hex');
const root = await fs.mkdtemp(path.resolve('test-results/engine-cache-native-'));
const data = path.join(root, 'data');
const cacheRoot = path.join(data, 'builds/engine-cache');
const names = async () =>
  (await fs.readdir(cacheRoot)).filter((n) => /^[a-f0-9]{64}$/.test(n)).sort();
const source = (n) => String.raw`\documentclass{article}
\begin{document}
Cache snapshot ${n}.
\end{document}`;
const report = {
  sourceCommit: (await promisify(execFile)('git', ['rev-parse', 'HEAD'])).stdout.trim(),
  sourceHashes: Object.fromEntries(
    await Promise.all(
      ['electron/core/compiler.ts', 'electron/core/engine-cache.ts'].map(async (p) => [
        p,
        await hash(p),
      ]),
    ),
  ),
  scriptSha256: await hash('scripts/test-engine-cache.mjs'),
  appAsarSha256: await hash(path.join(resources, 'app.asar')),
  runtimeManifestSha256: await hash(path.join(resources, 'runtime/manifest.json')),
  scope:
    'Actual packaged UI, compiler and cache in an isolated synthetic profile. Extra old caches contain inert bytes; oversized-cache UI is triggered by a scoped lstat size override. No real disk is filled. Native writer termination is separately tested with actual files and processes.',
  checks: [],
  errors: [],
  passed: false,
};
const env = { ...process.env, FOLIO_USER_DATA: data };
delete env.ELECTRON_RUN_AS_NODE;
delete env.FOLIO_TEST_RUNTIME_SEED;
let app, page;
const launch = async () => {
  app = await electron.launch({ executablePath, args: [], env, timeout: 60_000 });
  page = await app.firstWindow();
  page.setDefaultTimeout(20_000);
  page.on('pageerror', (error) => report.errors.push(error.message));
  await expect(page.getByLabel('Message the resume agent')).toBeEnabled({ timeout: 120_000 });
  await expect(page.locator('.compiler-preparation')).toHaveCount(0, { timeout: 120_000 });
  await page.getByRole('tab', { name: 'Code', exact: true }).click();
  await page.getByRole('checkbox', { name: 'Auto-compile', exact: true }).uncheck();
  await page.evaluate(() => window.folio.cancelBuild());
};
const close = async () => {
  const closed = page.waitForEvent('close');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  await closed;
  await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
  await app.close().catch(() => {});
  app = undefined;
};
const edit = async (n) => {
  await page.locator('.cm-content').press('ControlOrMeta+a');
  await page.keyboard.insertText(source(n));
  await expect(page.locator('.cm-content')).toContainText(`Cache snapshot ${n}.`);
};
const build = async (n) => {
  await page.getByRole('button', { name: 'Compile', exact: true }).click();
  await expect(page.getByText('Up to date', { exact: true })).toBeVisible({ timeout: 60_000 });
  await expect(page.locator('.preview-pane .textLayer')).toContainText(`Cache snapshot ${n}.`, {
    timeout: 60_000,
  });
};
try {
  await launch();
  await edit(1);
  await build(1);
  const runtimeId = (await names())[0];
  expect(await names()).toEqual([runtimeId]);
  const selected = path.join(cacheRoot, runtimeId);
  const format = path.join(
    selected,
    'formats',
    (await fs.readdir(path.join(selected, 'formats')))[0],
  );
  const first = {
    sha256: await hash(format),
    bytes: (await fs.stat(format)).size,
    mtimeMs: (await fs.stat(format)).mtimeMs,
  };
  expect(first.bytes).toBeGreaterThan(1_000_000);
  await edit(2);
  await build(2);
  expect(await hash(format)).toBe(first.sha256);
  expect((await fs.stat(format)).mtimeMs).toBe(first.mtimeMs);
  await fs.writeFile(path.join(cacheRoot, 'keep-unmarked'), 'Unmarked cache-root data');
  for (let i = 1; i <= 4; i++) {
    const folder = path.join(cacheRoot, i.toString(16).padStart(64, '0'));
    await fs.mkdir(folder);
    await fs.writeFile(path.join(folder, 'inert-format'), Buffer.alloc(256));
    await fs.utimes(folder, new Date(i * 1000), new Date(i * 1000));
  }
  expect((await names()).length).toBe(5);
  await edit(3);
  await build(3);
  expect(await names()).toEqual(['4'.padStart(64, '0'), runtimeId].sort());
  expect(await hash(format)).toBe(first.sha256);
  expect(await fs.readFile(path.join(cacheRoot, 'keep-unmarked'), 'utf8')).toBe(
    'Unmarked cache-root data',
  );
  report.retention = { before: 5, after: 2, warmFormat: first };
  report.checks.push(
    'Warm builds reuse exact format bytes and mtime. Five runtime caches are reduced to the current cache and newest idle cache, preserving unmarked data.',
  );

  await app.evaluate((_, selected) => {
    const io = process.getBuiltinModule('node:fs').promises;
    const original = io.lstat;
    io.lstat = async function (filename, ...args) {
      const info = await original.call(this, filename, ...args);
      if (String(filename).startsWith(selected + '/') && info.isFile())
        info.size = typeof info.size === 'bigint' ? 134217729n : 134217729;
      return info;
    };
    globalThis.folioCacheRestore = () => {
      io.lstat = original;
    };
  }, selected);
  await edit(4);
  await page.getByRole('button', { name: 'Compile', exact: true }).click();
  await expect(page.getByText('Build needs attention', { exact: true })).toBeVisible({
    timeout: 60_000,
  });
  if ((await page.getByTitle('Show or hide build output').getAttribute('aria-expanded')) !== 'true')
    await page.getByTitle('Show or hide build output').click();
  await expect(
    page.getByText('The compiler cache exceeded its storage limit.', { exact: false }).first(),
  ).toBeVisible();
  await expect(page.locator('.preview-pane .textLayer')).toContainText('Cache snapshot 3.');
  await expect(page.locator('.cm-content')).toContainText('Cache snapshot 4.');
  await expect
    .poll(async () =>
      fs.lstat(selected).then(
        () => true,
        () => false,
      ),
    )
    .toBe(false);
  await page.screenshot({ path: path.join(root, 'cache-limit.png') });
  await app.evaluate(() => globalThis.folioCacheRestore());
  await build(4);
  if ((await page.getByTitle('Show or hide build output').getAttribute('aria-expanded')) === 'true')
    await page.getByTitle('Show or hide build output').click();
  await page.screenshot({ path: path.join(root, 'cache-rebuilt.png') });
  report.checks.push(
    'A scoped oversized-file reading reaches the real build-error UI. Source and the last successful PDF remain available; the oversized cache is reclaimed and a normal retry rebuilds the current PDF.',
  );
  const rebuilt = { sha256: await hash(format), mtimeMs: (await fs.stat(format)).mtimeMs };
  await close();
  await launch();
  await expect(page.locator('.cm-content')).toContainText('Cache snapshot 4.');
  await build(4);
  expect(await hash(format)).toBe(rebuilt.sha256);
  expect((await fs.stat(format)).mtimeMs).toBe(rebuilt.mtimeMs);
  expect((await names()).length).toBeLessThanOrEqual(2);
  report.checks.push('Normal close/reopen retains the exact source and warm rebuilt format cache.');
  expect(report.errors).toEqual([]);
  report.passed = true;
  console.log(
    'PASS: bounded runtime caches, warm reuse, visible limit error, retained source/PDF and retry/restart.',
  );
} catch (error) {
  report.failure = { message: error.message, stack: error.stack };
  await page?.screenshot({ path: path.join(root, 'failure.png') }).catch(() => {});
  throw error;
} finally {
  await app?.evaluate(() => globalThis.folioCacheRestore?.()).catch(() => {});
  await fs.writeFile(path.join(root, 'result.json'), JSON.stringify(report, null, 2) + '\n');
  if (app) {
    await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
    await app.close().catch(() => {});
  }
  console.log(`Evidence: ${root}`);
}
