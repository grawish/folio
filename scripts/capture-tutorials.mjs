import { _electron as electron, expect } from '@playwright/test';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

// Capture real UI with an isolated synthetic project. Provider forms are examples;
// no account is configured and no inference request is sent by this script.
await fs.mkdir('test-results', { recursive: true });
const profile = await fs.mkdtemp(path.resolve('test-results/tutorials-'));
const executablePath = process.argv[2];
const env = { ...process.env, FOLIO_USER_DATA: profile };
delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({
  ...(executablePath ? { executablePath, args: [] } : { args: [process.cwd()] }),
  env,
  timeout: 60_000,
});
const output = path.resolve('docs/images');
await fs.mkdir(output, { recursive: true });
const captures = [];
try {
  const page = await app.firstWindow();
  await expect(page.getByLabel('Message the resume agent')).toBeEnabled({ timeout: 120_000 });
  await page.getByText('Up to date', { exact: true }).waitFor({ timeout: 60_000 });
  await expect(page.locator('.preview-pane .textLayer')).toContainText('Alex Morgan');
  const capture = async (name, description) => {
    const file = path.join(output, `${name}.png`);
    await page.screenshot({ path: file });
    captures.push({
      file: `docs/images/${name}.png`,
      description,
      sha256: createHash('sha256')
        .update(await fs.readFile(file))
        .digest('hex'),
    });
  };
  await capture('workspace', 'Default synthetic resume, no AI connection.');
  await page.getByRole('tab', { name: 'Code', exact: true }).click();
  await capture('code', 'Manual TeX editing and the matching PDF.');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'AI connections', exact: true }).click();
  await capture(
    'connections-empty',
    'AI connections are configured and selected only in Settings.',
  );
  await page.getByRole('button', { name: 'Add connection', exact: true }).click();
  for (const kind of ['codex', 'claude-code', 'openai', 'anthropic', 'custom']) {
    await page.getByLabel('Connection type', { exact: true }).selectOption(kind);
    await page.getByLabel('Connection name', { exact: true }).fill(`My ${kind} connection`);
    if (kind === 'custom')
      await page.getByLabel('Base URL', { exact: true }).fill('https://ai.example.com/v1');
    await capture(
      `connection-${kind}`,
      'Configuration example only; no account or key is connected.',
    );
  }
  await page.getByRole('button', { name: 'Back to connections', exact: true }).click();
  for (const [label, name] of [
    ['General', 'general'],
    ['Editor & PDF', 'editor-settings'],
    ['Privacy', 'privacy'],
    ['About', 'about'],
  ]) {
    await page.getByRole('button', { name: label, exact: true }).click();
    await capture(name, `${label} settings with a synthetic resume.`);
  }
  await page.getByRole('button', { name: 'General', exact: true }).click();
  await page.getByLabel('Appearance', { exact: true }).selectOption('light');
  await capture('general-light', 'Light appearance, autosave, pane reset and import recovery.');
  await fs.writeFile(
    path.join(output, 'capture-manifest.json'),
    JSON.stringify(
      {
        capturedAt: new Date().toISOString(),
        script: 'scripts/capture-tutorials.mjs',
        input: executablePath ? 'Packaged development app' : 'Source development app',
        synthetic: true,
        liveAI: false,
        captures,
      },
      null,
      2,
    ) + '\n',
  );
  console.log(`Captured ${captures.length} tutorial screens. Evidence: ${profile}`);
} finally {
  await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
  await app.close().catch(() => {});
}
