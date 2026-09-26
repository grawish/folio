import { _electron as electron, expect } from '@playwright/test';
import { promises as fs } from 'node:fs';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import path from 'node:path';
import { buildResourcePack } from '../electron/core/resource-pack.ts';
import { CATALOG_SIGNATURE_CONTEXT } from '../electron/core/pack-catalog.ts';
import { buildElectron } from './build-electron.mjs';

const root = await fs.mkdtemp(path.resolve('test-results/packs-'));
const data = path.join(root, 'data'),
  projectFolder = path.join(root, 'project');
await fs.mkdir(projectFolder);
const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const source = String.raw`\documentclass{article}\usepackage{folio-pack-check}\begin{document}\FolioPackCheck\end{document}`;
const built = await buildResourcePack({
  baseRoot: path.resolve('resources/runtime/mac-arm64'),
  id: 'folio-native-ui-v1',
  title: 'Folio pack workflow example',
  description: 'An original small package used to verify the resource workflow.',
  bundle: 'folio-native-ui-v1',
  packages: ['folio-pack-check.sty'],
  resources: new Map([
    [
      'folio-pack-check.sty',
      Buffer.from(
        String.raw`\ProvidesPackage{folio-pack-check}[2026/09/26 Folio test]\newcommand{\FolioPackCheck}{Folio signed resource pack preview.}\endinput`,
      ),
    ],
  ]),
  notices:
    'Original Folio workflow fixture. PolyForm Noncommercial 1.0.0. This test pack is not a published product.',
  probe: source,
  keyId: 'native-test',
  privateKey,
});
const archivePath = path.join(root, 'example.foliopack');
await fs.writeFile(archivePath, built.archive);
const { id, title, description, base, target, packages } = built.description;
const payload = Buffer.from(
  JSON.stringify({
    schemaVersion: 1,
    sequence: 1,
    issuedAt: new Date(Date.now() - 1000).toISOString(),
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    packs: [
      {
        id,
        title,
        description,
        base,
        target,
        packages,
        artifact: {
          url: 'https://packs.test/example.foliopack',
          bytes: built.archive.length,
          sha256: createHash('sha256').update(built.archive).digest('hex'),
        },
      },
    ],
  }),
);
const catalog = JSON.stringify({
  keyId: 'native-test',
  payload: payload.toString('base64'),
  signature: sign(
    null,
    Buffer.concat([Buffer.from(CATALOG_SIGNATURE_CONTEXT), payload]),
    privateKey,
  ).toString('base64'),
});
await buildElectron({
  packTestTrust: {
    keys: { 'native-test': publicKey.export({ format: 'pem', type: 'spki' }).toString() },
    hosts: ['packs.test'],
    catalogUrl: 'https://packs.test/catalog.json',
    minimumSequence: 1,
  },
});
const env = { ...process.env, FOLIO_USER_DATA: data };
delete env.ELECTRON_RUN_AS_NODE;
const errors = [];
let app, page;
const launch = async () => {
  app = await electron.launch({ args: [process.cwd()], env, timeout: 120_000 });
  page = await app.firstWindow();
  page.setDefaultTimeout(30_000);
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (item) => {
    if (item.type() === 'error') errors.push(item.text());
  });
  await page.locator('.app-shell').waitFor();
  await expect(page.getByLabel('Message the resume agent')).toBeEnabled({ timeout: 120_000 });
};
const close = async () => {
  const closed = page.waitForEvent('close');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  await closed;
  await app.close().catch(() => {});
};
const choose = (filename) =>
  app.evaluate(({ dialog }, filePath) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filePath] });
  }, filename);
const configureTransport = (slow) =>
  app.evaluate(
    (_, { catalog, archive, slow }) => {
      globalThis.packTestRequests = [];
      globalThis.fetch = async (url, options) => {
        const headers = new Headers(options.headers);
        globalThis.packTestRequests.push({ url: String(url), range: headers.get('Range') });
        if (String(url).endsWith('catalog.json')) return new Response(catalog);
        const bytes = Buffer.from(archive, 'base64');
        const start = Number(headers.get('Range')?.match(/^bytes=(\d+)-/)?.[1] ?? 0);
        const remaining = bytes.subarray(start);
        const responseHeaders = {
          'Content-Length': String(remaining.length),
          ETag: '"fixture-v1"',
        };
        if (start)
          responseHeaders['Content-Range'] = `bytes ${start}-${bytes.length - 1}/${bytes.length}`;
        let timer;
        const stream = new ReadableStream({
          start(controller) {
            if (!slow || remaining.length <= 128) {
              controller.enqueue(remaining);
              controller.close();
              return;
            }
            controller.enqueue(remaining.subarray(0, 128));
            const abort = () => {
              clearTimeout(timer);
              controller.error(new Error('Synthetic transfer cancelled'));
            };
            options.signal.addEventListener('abort', abort, { once: true });
            timer = setTimeout(() => {
              options.signal.removeEventListener('abort', abort);
              controller.enqueue(remaining.subarray(128));
              controller.close();
            }, 30_000);
          },
          cancel() {
            clearTimeout(timer);
          },
        });
        return new Response(stream, { status: start ? 206 : 200, headers: responseHeaders });
      };
    },
    { catalog, archive: built.archive.toString('base64'), slow },
  );
const settings = async () => {
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'LaTeX resources', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Reload saved packs', exact: true })).toBeEnabled();
};
const card = () => page.getByRole('article', { name: title, exact: true });
const downloadStarted = async () => {
  await expect
    .poll(async () =>
      Number(
        await page
          .getByRole('progressbar', { name: 'Resource pack progress' })
          .getAttribute('value'),
      ),
    )
    .toBeGreaterThan(0);
};
try {
  await launch();
  await choose(projectFolder);
  await page.getByRole('button', { name: 'Save project', exact: true }).click();
  await page.getByText('Saved locally', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Editor & PDF', exact: true }).click();
  await page.getByLabel('Automatic preview').uncheck();
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await page.getByRole('tab', { name: 'Code', exact: true }).click();
  await page.locator('.cm-content').click();
  await page.locator('.cm-content').press('ControlOrMeta+A');
  await page.keyboard.insertText(source);
  await page.getByRole('button', { name: 'Save project', exact: true }).click();
  await page.getByText('Saved locally', { exact: true }).waitFor();
  const original = JSON.parse(
    await fs.readFile(path.join(projectFolder, 'resume.project.json'), 'utf8'),
  );
  await settings();
  await choose(archivePath);
  await page.getByRole('button', { name: 'Import pack file', exact: true }).click();
  const preview = page.getByRole('article', { name: 'Review imported pack' });
  await expect(preview).toContainText(title);
  await preview.getByText('Package notices', { exact: true }).click();
  await expect(page.getByLabel('Imported pack notices')).toHaveValue(/PolyForm/);
  await page.screenshot({ path: path.join(root, 'import-review-dark.png') });
  await page.getByRole('button', { name: 'Discard import', exact: true }).click();
  await expect(preview).toHaveCount(0);
  await configureTransport(true);
  await page.evaluate(async () => {
    await new Promise((resolve, reject) => {
      const observer = new MutationObserver(() => {
        const cancel = [...document.querySelectorAll('button')].find(
          (button) => button.textContent.trim() === 'Cancel operation',
        );
        if (cancel) {
          observer.disconnect();
          clearTimeout(timeout);
          cancel.click();
          resolve();
        }
      });
      const timeout = setTimeout(() => {
        observer.disconnect();
        reject(new Error('The pack cancellation control did not appear.'));
      }, 5000);
      observer.observe(document.body, { childList: true, subtree: true });
      [...document.querySelectorAll('button')]
        .find((button) => button.textContent.trim() === 'Check for packs')
        .click();
    });
  });
  await expect(page.getByRole('button', { name: 'Reload saved packs', exact: true })).toBeEnabled();
  expect(await app.evaluate(() => globalThis.packTestRequests)).toEqual([]);
  console.log('PASS: cancelling during draft preparation prevents the later catalog request.');
  await page.getByRole('button', { name: 'Check for packs', exact: true }).click();
  await expect(card()).toBeVisible();
  await page.screenshot({ path: path.join(root, 'catalog-dark.png') });
  await card().getByRole('button', { name: 'Download and install', exact: true }).click();
  await downloadStarted();
  await page.screenshot({ path: path.join(root, 'download-progress.png') });
  await page.getByRole('button', { name: 'Cancel operation', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Reload saved packs', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Reload saved packs', exact: true }).click();
  await expect(
    card().getByRole('button', { name: 'Resume and install', exact: true }),
  ).toBeEnabled();
  await card().getByRole('button', { name: 'Resume and install', exact: true }).click();
  await downloadStarted();
  await close();
  console.log(
    'PASS: explicit cancellation and native close retain a resumable signed download without changing the project.',
  );

  await launch();
  await configureTransport(false);
  await settings();
  await card().getByRole('button', { name: 'Resume and install', exact: true }).click();
  await page
    .getByText('Preparing a separate compiler copy…', { exact: true })
    .waitFor({ timeout: 120_000 });
  await page.reload();
  await expect(page.getByLabel('Message the resume agent')).toBeEnabled({ timeout: 120_000 });
  await settings();
  await expect(
    card().getByRole('button', { name: 'Install saved pack', exact: true }),
  ).toBeEnabled();
  expect(
    JSON.parse(await fs.readFile(path.join(projectFolder, 'resume.project.json'), 'utf8')).runtime,
  ).toEqual(original.runtime);
  expect(
    await app.evaluate(() =>
      globalThis.packTestRequests.some((request) => request.range?.startsWith('bytes=256-')),
    ),
  ).toBe(true);
  await app.evaluate(() => {
    globalThis.fetch = async () => {
      throw new Error('Offline test: network unavailable');
    };
  });
  await card().getByRole('button', { name: 'Install saved pack', exact: true }).click();
  await page
    .getByText('Testing the compiler and pack offline…', { exact: true })
    .waitFor({ timeout: 120_000 });
  await page.screenshot({ path: path.join(root, 'offline-check.png') });
  await expect(
    card().getByRole('button', { name: 'Preview for this project', exact: true }),
  ).toBeEnabled({ timeout: 120_000 });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1040, 680));
  await page.getByRole('button', { name: 'General', exact: true }).click();
  await page.getByLabel('Appearance', { exact: true }).selectOption('light');
  await page.getByRole('button', { name: 'LaTeX resources', exact: true }).click();
  await expect(
    card().getByRole('button', { name: 'Preview for this project', exact: true }),
  ).toBeEnabled();
  await page.screenshot({ path: path.join(root, 'installed-small-light.png') });
  const bounds = await page.getByRole('button', { name: 'Done', exact: true }).boundingBox();
  expect(bounds.y + bounds.height).toBeLessThan(680);
  console.log(
    'PASS: reload cancels staging; retained signed archives install and pass real pack/Biber checks offline.',
  );

  await card().getByRole('button', { name: 'Preview for this project', exact: true }).click();
  await page.getByRole('button', { name: 'Build comparison', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Use this pack', exact: true })).toBeEnabled({
    timeout: 120_000,
  });
  await expect(
    page.getByText('No before PDF is available for this source.', { exact: true }),
  ).toBeVisible();
  await expect(page.locator('.compiler-comparison canvas').first()).toBeVisible();
  await page.screenshot({ path: path.join(root, 'pack-preview-light.png') });
  expect(
    JSON.parse(await fs.readFile(path.join(projectFolder, 'resume.project.json'), 'utf8')).runtime,
  ).toEqual(original.runtime);
  await page.getByRole('button', { name: 'Use this pack', exact: true }).click();
  await page.getByRole('button', { name: 'Save project', exact: true }).click();
  await page.getByText('Saved locally', { exact: true }).waitFor();
  const changed = JSON.parse(
    await fs.readFile(path.join(projectFolder, 'resume.project.json'), 'utf8'),
  );
  expect(changed.runtime).toEqual(target);
  expect(await fs.readFile(path.join(projectFolder, 'main.tex'), 'utf8')).toBe(source);
  const backups = await page.evaluate((id) => window.folio.compilerBackups(id), changed.id);
  expect(backups.at(0).from).toEqual(original.runtime);
  expect(backups.at(0).to).toEqual(target);
  await close();
  await launch();
  const restored = await page.evaluate(() => window.folio.bootstrap());
  expect(restored.recovered.runtime).toEqual(target);
  expect(restored.recovered.files.find((file) => file.path === 'main.tex').content).toBe(source);
  expect(restored.runtime.ready).toBe(true);
  expect(errors).toEqual([]);
  await fs.writeFile(
    path.join(root, 'result.json'),
    JSON.stringify(
      {
        passed: true,
        errors,
        target,
        before: original.runtime,
        testTrust:
          'Ephemeral build-time public key; synthetic HTTPS transport; real compiler and sandbox.',
      },
      null,
      2,
    ),
  );
  console.log(
    'PASS: a real pack repairs a missing dependency only after preview and Apply, preserves source and backup, and survives save/restart. No renderer errors.',
  );
  console.log(`Evidence: ${root}`);
} catch (error) {
  await page?.screenshot({ path: path.join(root, 'failure.png') }).catch(() => {});
  console.error(`Evidence: ${root}`);
  throw error;
} finally {
  await app?.evaluate(({ app }) => app.exit(0)).catch(() => {});
  await app?.close().catch(() => {});
  await buildElectron();
}
