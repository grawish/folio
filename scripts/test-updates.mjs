import { _electron as electron, expect } from '@playwright/test';
import { promises as fs } from 'node:fs';
import path from 'node:path';

await fs.mkdir('test-results', { recursive: true });
const root = await fs.mkdtemp(path.resolve('test-results/app-updates-'));
const publisher = JSON.parse(await fs.readFile('resources/app-update-publisher.json', 'utf8'));
const preview = Object.keys(publisher.keys).length === 0;
const env = { ...process.env, FOLIO_USER_DATA: path.join(root, 'data') };
delete env.ELECTRON_RUN_AS_NODE;
const launch = () =>
  electron.launch({
    ...(process.argv[2]
      ? { executablePath: path.resolve(process.argv[2]), args: [] }
      : { args: [process.cwd()] }),
    env,
    timeout: 60_000,
  });
let app = await launch(),
  page;
const errors = [],
  checks = [];
const open = async () => {
  page = await app.firstWindow();
  page.on('pageerror', (error) => errors.push(error.message));
  await expect(page.getByLabel('Message the resume agent')).toBeEnabled({ timeout: 120_000 });
  await expect(page.locator('.compiler-preparation')).toHaveCount(0, { timeout: 120_000 });
};
const settings = async () => {
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'App updates', exact: true }).click();
};
const close = async () => {
  const closed = page.waitForEvent('close');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  await closed;
  await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
  await app.close().catch(() => {});
};
try {
  await open();
  await page.getByLabel('Message the resume agent').fill('Keep my draft while checking updates.');
  await page.getByLabel('Project name', { exact: true }).fill('Update recovery example');
  await settings();
  await expect(page.getByLabel('Update channel', { exact: true })).toHaveValue('stable');
  await expect(page.getByLabel('Check for app updates automatically')).not.toBeChecked();
  await page.getByLabel('Update channel', { exact: true }).selectOption('beta');
  await expect
    .poll(
      async () =>
        JSON.parse(await fs.readFile(path.join(root, 'data/app-updates/state.json'), 'utf8'))
          .preferences.channel,
    )
    .toBe('beta');
  await page.getByLabel('Check for app updates automatically').check();
  await expect
    .poll(
      async () =>
        JSON.parse(await fs.readFile(path.join(root, 'data/app-updates/state.json'), 'utf8'))
          .preferences.automatic,
    )
    .toBe(true);
  // Disable before leaving: the native test must not schedule background network checks.
  await page.getByLabel('Check for app updates automatically').uncheck();
  if (preview) {
    await page.getByRole('button', { name: 'Check for updates', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('not configured for this preview');
  } else {
    await expect(
      page.getByRole('button', { name: 'Check for updates', exact: true }),
    ).toBeEnabled();
  }
  await expect(page.getByRole('button', { name: 'Download update', exact: true })).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Save recovery & restart', exact: true }),
  ).toHaveCount(0);
  checks.push(
    'Persistent stable/beta preferences, opt-in checks and no install action without an approved download.',
  );
  if (preview)
    checks.push('Unconfigured publisher fails closed before network access or installation.');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1480, 960));
  await page.screenshot({ path: path.join(root, 'updates-dark.png') });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1040, 680));
  for (const name of ['App updates', 'Done']) {
    const button = page.getByRole('button', { name, exact: true });
    await expect(button).toBeInViewport();
    expect(
      await button.evaluate((node) => {
        const box = node.getBoundingClientRect();
        return node.contains(
          document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2),
        );
      }),
    ).toBe(true);
  }
  await page
    .getByRole('button', { name: 'Downloads on GitHub', exact: true })
    .scrollIntoViewIfNeeded();
  await expect(
    page.getByRole('button', { name: 'Downloads on GitHub', exact: true }),
  ).toBeInViewport();
  await page.screenshot({ path: path.join(root, 'updates-compact.png') });
  await page.getByRole('button', { name: 'General', exact: true }).click();
  await page.getByLabel('Appearance', { exact: true }).selectOption('light');
  await page.getByRole('button', { name: 'App updates', exact: true }).click();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1480, 960));
  await page.screenshot({ path: path.join(root, 'updates-light.png') });
  checks.push('Dark, light and 1040×680 Settings controls are reachable.');
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(page.getByLabel('Message the resume agent')).toHaveValue(
    'Keep my draft while checking updates.',
  );
  await close();
  app = await launch();
  await open();
  await expect(page.getByLabel('Project name', { exact: true })).toHaveValue(
    'Update recovery example',
  );
  await expect(page.getByLabel('Message the resume agent')).toHaveValue(
    'Keep my draft while checking updates.',
  );
  await settings();
  await expect(page.getByLabel('Update channel', { exact: true })).toHaveValue('beta');
  await expect(page.getByLabel('Check for app updates automatically')).not.toBeChecked();
  checks.push('Normal quit/relaunch retains update preferences, project draft and chat draft.');
  // Inspect the native menu action instead of using a renderer shortcut.
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(page.getByRole('button', { name: 'App updates', exact: true })).toHaveCount(0);
  await app.evaluate(({ Menu }) =>
    Menu.getApplicationMenu()
      .items.find((item) => item.label === 'Folio')
      .submenu.items.find((item) => item.label === 'Check for updates…')
      .click(),
  );
  await expect(page.getByRole('heading', { name: 'App updates', exact: true })).toBeVisible();

  // Exercise the real renderer and close/recovery flow with a controlled IPC
  // failure. This does not claim native staging or bypass the production gate:
  // the fixture replaces one restart handler and never calls the real installer.
  const status = await page.evaluate(() => window.folio.appUpdateStatus());
  // Wait for AppUpdates' initial status request and event subscription, not
  // just the heading rendered before its effect runs.
  await expect(page.getByText(status.message, { exact: true })).toBeVisible();
  // This is a controlled UI state; native transfer/storage controls run in the
  // separate Electron adapter fixture without filling the developer's disk.
  await app.evaluate(({ BrowserWindow }, status) => {
    BrowserWindow.getAllWindows()[0].webContents.send('updates:status', {
      ...status,
      phase: 'error',
      canInstall: true,
      installReason: undefined,
      message:
        'This app update needs about 3.5 GB free on the update-cache disk. Free some space and check for updates again. Your documents are kept.',
    });
  }, status);
  await expect(page.getByRole('alert')).toContainText('Free some space');
  await expect(page.getByRole('button', { name: 'Check for updates', exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Done', exact: true })).toBeEnabled();
  await page.screenshot({ path: path.join(root, 'updates-disk-space.png') });
  checks.push('A simulated low-disk status shows space/retry guidance and leaves Settings usable.');
  const failureMessage =
    'App update preparation took longer than two minutes. You can keep working. Save your changes, then quit and reopen Folio before retrying. macOS may finish this update when Folio closes.';
  await app.evaluate(
    ({ BrowserWindow, ipcMain }, { status, failureMessage }) => {
      const original = ipcMain._invokeHandlers.get('updates:restart');
      const window = BrowserWindow.getAllWindows()[0];
      const downloaded = {
        ...status,
        phase: 'downloaded',
        version: '0.2.0',
        canInstall: true,
        installReason: undefined,
      };
      ipcMain._invokeHandlers.set('updates:restart', async () => {
        ipcMain._invokeHandlers.set('updates:restart', original);
        window.webContents.send('updates:status', {
          ...downloaded,
          phase: 'restarting',
          message: 'macOS is preparing the update. This can take up to two minutes…',
        });
        await new Promise((resolve) => setTimeout(resolve, 100));
        window.webContents.send('updates:status', {
          ...downloaded,
          phase: 'error',
          canInstall: false,
          installReason: 'Quit and reopen Folio before trying another app update.',
          message: failureMessage,
        });
        throw new Error(failureMessage);
      });
      window.webContents.send('updates:status', downloaded);
    },
    { status, failureMessage },
  );
  await page.getByRole('button', { name: 'Save recovery & restart', exact: true }).click();
  await expect(page.getByRole('alert').first()).toContainText('longer than two minutes');
  await expect(page.getByRole('button', { name: 'Done', exact: true })).toBeEnabled();
  await expect(
    page.getByRole('button', { name: 'Save recovery & restart', exact: true }),
  ).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Download update', exact: true })).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Downloads on GitHub', exact: true }),
  ).toBeEnabled();
  await page.screenshot({ path: path.join(root, 'updates-staging-recovery.png') });
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(page.getByRole('button', { name: 'App updates', exact: true })).toHaveCount(0);
  await page
    .getByLabel('Message the resume agent')
    .fill('New draft after update preparation failed.');
  await page
    .getByLabel('Project name', { exact: true })
    .fill('Work continued after update failure');
  await expect(page.getByLabel('Project name', { exact: true })).toHaveAttribute(
    'title',
    'Work continued after update failure',
  );
  await close();
  app = await launch();
  await open();
  await expect(page.getByLabel('Project name', { exact: true })).toHaveValue(
    'Work continued after update failure',
  );
  await expect(page.getByLabel('Message the resume agent')).toHaveValue(
    'New draft after update preparation failed.',
  );
  checks.push(
    'A simulated restart IPC failure unlocks Settings and preserves subsequent project/chat edits through normal quit and reopen.',
  );
  expect(errors).toEqual([]);
  await fs.writeFile(
    path.join(root, 'result.json'),
    JSON.stringify(
      {
        passed: true,
        checks,
        nativeInstallationTested: false,
        productionTrustConfigured: !preview,
        stagingFailureSimulated: true,
        diskSpaceFailureSimulated: true,
      },
      null,
      2,
    ),
  );
  console.log('PASS: app update Settings, preview gate and recovery.');
  console.log(`Evidence: ${root}`);
} catch (error) {
  await page?.screenshot({ path: path.join(root, 'failure.png') }).catch(() => {});
  throw error;
} finally {
  await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
  await app.close().catch(() => {});
}
