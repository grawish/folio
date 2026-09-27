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
  await app.evaluate(({ Menu }) =>
    Menu.getApplicationMenu()
      .items.find((item) => item.label === 'Folio')
      .submenu.items.find((item) => item.label === 'Check for updates…')
      .click(),
  );
  await expect(page.getByRole('heading', { name: 'App updates', exact: true })).toBeVisible();
  expect(errors).toEqual([]);
  await fs.writeFile(
    path.join(root, 'result.json'),
    JSON.stringify(
      {
        passed: true,
        checks,
        nativeInstallationTested: false,
        productionTrustConfigured: !preview,
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
