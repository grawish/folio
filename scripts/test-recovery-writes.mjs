import { _electron as electron, expect } from '@playwright/test';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

if (process.platform !== 'darwin' || process.arch !== 'arm64' || !process.argv[2])
  throw new Error('Provide a packaged Folio executable on an Apple silicon Mac.');
const exec = promisify(execFile);
const executablePath = path.resolve(process.argv[2]);
const resources = path.resolve(path.dirname(executablePath), '../Resources');
const hash = async (file) =>
  createHash('sha256')
    .update(await fs.readFile(file))
    .digest('hex');
const root = await fs.mkdtemp(path.resolve('test-results/recovery-writes-'));
const data = path.join(root, 'data'),
  recoveryFile = path.join(data, 'recovery.json');
const settingsFile = path.join(data, 'workspace-preferences.json');
const source = (n) => String.raw`\documentclass{article}
\begin{document}
Recovery snapshot ${n}.
\end{document}`;
const read = async () => JSON.parse(await fs.readFile(recoveryFile, 'utf8')).project;
const text = async () => (await read()).files.find((f) => f.path === 'main.tex').content;
const report = {
  sourceCommit: (await exec('git', ['rev-parse', 'HEAD'])).stdout.trim(),
  scriptSha256: await hash('scripts/test-recovery-writes.mjs'),
  sourceHashes: Object.fromEntries(
    await Promise.all(
      [
        'electron/core/project.ts',
        'electron/main.ts',
        'src/shared/recovery-writes.ts',
        'src/App.tsx',
        'src/chat.css',
      ].map(async (file) => [file, await hash(file)]),
    ),
  ),
  appAsarSha256: await hash(path.join(resources, 'app.asar')),
  runtimeManifestSha256: await hash(path.join(resources, 'runtime/manifest.json')),
  scope:
    'Synthetic native profile, real UI/preload/IPC/recovery and normal restarts. Scoped rename delays/failures expose queue behavior. No AI call, real user document, performance percentile or physical power-loss claim.',
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
  page.setDefaultTimeout(15_000);
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
  await expect(page.locator('.cm-content')).toContainText(`Recovery snapshot ${n}.`);
};
const install = (mode) =>
  app.evaluate(
    (_, { recoveryFile, settingsFile, mode }) => {
      const io = process.getBuiltinModule('node:fs').promises;
      const original = io.rename.bind(io);
      let release;
      const hold = new Promise((resolve) => {
        release = resolve;
      });
      const state = {
        mode,
        entered: false,
        calls: [],
        settingsCalls: 0,
        release,
        restore: () => {
          io.rename = original;
        },
      };
      io.rename = async (from, to) => {
        if (to === recoveryFile) {
          const value = JSON.parse(await io.readFile(from, 'utf8'));
          state.calls.push({
            revision: value.project.revision,
            id: value.project.id,
            source: value.project.files.find((f) => f.path === 'main.tex').content,
          });
          if (mode === 'hold' && !state.entered) {
            state.entered = true;
            await hold;
          }
          if (mode === 'fail') throw new Error('Synthetic recovery write failure');
        }
        if (mode === 'fail' && to === settingsFile) {
          state.settingsCalls++;
          throw new Error('Synthetic settings write failure');
        }
        return original(from, to);
      };
      globalThis.folioRecoveryFixture = state;
    },
    { recoveryFile, settingsFile, mode },
  );
const restore = () =>
  app.evaluate(() => {
    globalThis.folioRecoveryFixture.release();
    globalThis.folioRecoveryFixture.restore();
  });
try {
  await launch();
  await edit(0);
  await expect.poll(text).toBe(source(0));
  await install('hold');
  await edit(1);
  await expect.poll(() => app.evaluate(() => globalThis.folioRecoveryFixture.entered)).toBe(true);
  for (let i = 2; i <= 8; i++) {
    await edit(i);
    // Let each real 500 ms recovery debounce fire while the first disk write stays held.
    await page.waitForTimeout(650);
  }
  await app.evaluate(() => globalThis.folioRecoveryFixture.release());
  await expect.poll(text).toBe(source(8));
  report.automaticWrites = await app.evaluate(() => globalThis.folioRecoveryFixture.calls);
  expect(report.automaticWrites.map((w) => w.source)).toEqual([source(1), source(8)]);
  await restore();
  await close();
  await launch();
  await expect(page.locator('.cm-content')).toContainText('Recovery snapshot 8.');
  await expect.poll(text).toBe(source(8));
  report.checks.push(
    'Eight debounce-separated UI snapshots become only the active and newest writes; exact newest source survives normal close and restart.',
  );

  await page.waitForTimeout(700);
  const previous = await fs.readFile(recoveryFile);
  await install('fail');
  await edit(9);
  await expect(page.getByRole('button', { name: 'Retry recovery', exact: true })).toBeVisible();
  await edit(10);
  await page.waitForTimeout(650);
  expect(await fs.readFile(recoveryFile)).toEqual(previous);
  expect(await app.evaluate(() => globalThis.folioRecoveryFixture.calls.length)).toBe(1);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'General', exact: true }).click();
  await page.getByLabel('Appearance', { exact: true }).selectOption('light');
  await expect(
    page.getByRole('button', { name: 'Retry settings save', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  const recoveryBox = await page.locator('.recovery-error').boundingBox();
  const settingsBox = await page.locator('.preference-error').boundingBox();
  expect(recoveryBox.y + recoveryBox.height).toBeLessThanOrEqual(settingsBox.y);
  await page.screenshot({ path: path.join(root, 'recovery-retry.png') });
  await restore();
  await page.getByRole('button', { name: 'Retry settings save', exact: true }).click();
  await expect(page.locator('.preference-error')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Retry recovery', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Retry recovery', exact: true }).click();
  await expect(page.locator('.recovery-error')).toHaveCount(0);
  await expect.poll(text).toBe(source(10));
  await page.screenshot({ path: path.join(root, 'recovery-retried.png') });
  report.checks.push(
    'A failed rename preserves the previous recovery file, retains newer editor changes without repeated writes, and Retry saves the newest source. Independent recovery/settings errors remain visible and clickable without overlapping.',
  );

  const current = await read();
  await install('hold');
  await page.evaluate((current) => {
    window.folioRecoveryResults = [];
    window.folioRecoveryPromises = [];
    window.folioRecoveryProject = (i) => ({
      ...current,
      revision: current.revision + 1000 + i,
      files: [{ path: 'main.tex', content: `Native admission snapshot ${i}.` }],
    });
    window.folioEnqueueRecovery = (i) => {
      const promise = window.folio.recover(window.folioRecoveryProject(i)).then(
        () => {
          const result = { i, status: 'saved' };
          window.folioRecoveryResults.push(result);
          return result;
        },
        (error) => {
          const result = { i, status: 'rejected', message: error.message };
          window.folioRecoveryResults.push(result);
          return result;
        },
      );
      window.folioRecoveryPromises.push(promise);
    };
    window.folioEnqueueRecovery(0);
  }, current);
  await expect.poll(() => app.evaluate(() => globalThis.folioRecoveryFixture.entered)).toBe(true);
  await page.evaluate(() => {
    for (let i = 1; i < 100; i++) window.folioEnqueueRecovery(i);
  });
  await expect.poll(() => page.evaluate(() => window.folioRecoveryResults.length)).toBe(96);
  const whileHeld = await page.evaluate(() => window.folioRecoveryResults);
  expect(
    whileHeld.every((r) => r.status === 'rejected' && r.message.includes('Recovery is busy')),
  ).toBe(true);
  await app.evaluate(() => globalThis.folioRecoveryFixture.release());
  const results = await page.evaluate(() => Promise.all(window.folioRecoveryPromises));
  expect(results.filter((r) => r.status === 'saved').map((r) => r.i)).toEqual([0, 1, 2, 3]);
  expect(await text()).toBe('Native admission snapshot 3.');
  await page.evaluate(() => window.folio.recover(window.folioRecoveryProject(99)));
  expect(await text()).toBe('Native admission snapshot 99.');
  report.nativeAdmission = {
    requests: 100,
    rejectedWhileHeld: whileHeld.length,
    acknowledgedWhileHeld: 0,
    accepted: 4,
    newestRetrySaved: true,
  };
  await restore();
  await close();
  await launch();
  await expect(page.locator('.cm-content')).toContainText('Recovery snapshot 10.');
  await expect.poll(text).toBe(source(10));
  report.checks.push(
    'Native IPC admits four writes, rejects excess requests before acknowledgement, and accepts a later retry. Normal close flushes the actual visible editor snapshot before restart.',
  );
  expect(report.errors).toEqual([]);
  report.passed = true;
  console.log(
    'PASS: bounded automatic recovery, durable native admission, visible retry, independent notifications and close/restart.',
  );
} catch (error) {
  report.failure = { message: error.message, stack: error.stack };
  await page?.screenshot({ path: path.join(root, 'failure.png') }).catch(() => {});
  throw error;
} finally {
  await app
    ?.evaluate(() => {
      globalThis.folioRecoveryFixture?.release();
      globalThis.folioRecoveryFixture?.restore();
    })
    .catch(() => {});
  await fs.writeFile(path.join(root, 'result.json'), JSON.stringify(report, null, 2) + '\n');
  if (app) {
    await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
    await app.close().catch(() => {});
  }
  console.log(`Evidence: ${root}`);
}
