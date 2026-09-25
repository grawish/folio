import { createServer } from 'vite';
import { _electron as electron, expect } from '@playwright/test';
import { promises as fs } from 'node:fs';
import path from 'node:path';
const server = await createServer();
await server.listen();
const data = await fs.mkdtemp(path.resolve('test-results/dev-'));
const env = { ...process.env, VITE_DEV_SERVER_URL: 'http://127.0.0.1:5173', FOLIO_USER_DATA: data };
delete env.ELECTRON_RUN_AS_NODE;
let app;
try {
  app = await electron.launch({ args: [process.cwd()], env, timeout: 60_000 });
  const page = await app.firstWindow();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await expect(page.getByLabel('Message the resume agent')).toBeEnabled({ timeout: 120_000 });
  await page.getByText('Up to date', { exact: true }).waitFor({ timeout: 30_000 });
  await expect(page.locator('.preview-pane .textLayer')).toContainText('Alex Morgan', {
    timeout: 10_000,
  });
  expect(errors).toEqual([]);
  console.log('PASS: Vite + Electron development workflow renders the app and compiles a resume.');
} finally {
  if (app) {
    await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
    await app.close().catch(() => {});
  }
  await server.close();
}
