import { _electron as electron, expect } from '@playwright/test';
import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';

const [executableArg, mode = 'disposed'] = process.argv.slice(2);
if (!executableArg || !['disposed', 'mounted'].includes(mode) || process.argv.length > 4)
  throw new Error('Provide the exact packaged executable and optionally disposed or mounted.');
const executablePath = path.resolve(executableArg);
const asar = path.resolve(path.dirname(executablePath), '../Resources/app.asar');
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
await fs.mkdir('test-results', { recursive: true });
const root = await fs.mkdtemp(path.resolve('test-results/editor-input-'));
const dataRoot = path.join(root, 'app-data');
const folder = path.join(root, 'project');
await fs.mkdir(folder);
const base = String.raw`\documentclass{article}
\begin{document}
Editor input fixture.
\end{document}
`;
await fs.writeFile(path.join(folder, 'main.tex'), base);
const script = await fs.readFile(fileURLToPath(import.meta.url));
await fs.writeFile(path.join(root, 'harness.mjs'), script);
const report = {
  sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  scriptSha256: hash(script),
  appAsarSha256: hash(await fs.readFile(asar)),
  runtimeManifestSha256: hash(
    await fs.readFile(path.resolve(path.dirname(asar), 'runtime/manifest.json')),
  ),
  editorLifecycle: mode,
  host: {
    platform: process.platform,
    arch: process.arch,
    os: os.release(),
    cpu: os.cpus()[0].model,
    node: process.version,
  },
  startedAt: new Date().toISOString(),
  explicitGcRequested: false,
  scope:
    'Packaged native app with synthetic source. Ordinary ASCII input uses key events; composition uses Chromium Input.imeSetComposition and Input.insertText through CDP. This checks browser composition and view-lifecycle behavior, not a physical Mac input-source/candidate-window, VoiceOver or timing/memory-budget acceptance. Unicode is entered in TeX comments so these checks do not test font glyph coverage. Source setup replacements and deliberate history-group separation are outside the keyboard/composition cases.',
  cases: [],
  observations: [],
  errors: [],
  passed: false,
};
const env = { ...process.env, FOLIO_USER_DATA: dataRoot };
delete env.ELECTRON_RUN_AS_NODE;
delete env.FOLIO_TEST_RUNTIME_SEED;
let app, page, session;
const source = async () => {
  const recovery = JSON.parse(await fs.readFile(path.join(dataRoot, 'recovery.json'), 'utf8'));
  return recovery.project.files.find((file) => file.path === 'main.tex').content;
};
const editor = () => page.locator('.cm-content');
const code = () => page.getByRole('tab', { name: 'Code', exact: true }).click();
const chat = async () => {
  await page.getByRole('tab', { name: 'Chat', exact: true }).click();
  await expect(page.locator('.cm-editor')).toHaveCount(mode === 'disposed' ? 0 : 1);
};
const settleSource = (expected) => expect.poll(source, { timeout: 15_000 }).toBe(expected);
const observe = async (label) => {
  report.observations.push({
    label,
    at: new Date().toISOString(),
    dom: await session.send('Memory.getDOMCounters'),
    heap: await session.send('Runtime.getHeapUsage'),
  });
};
const launch = async () => {
  app = await electron.launch({ executablePath, args: [], env, timeout: 60_000 });
  page = await app.firstWindow();
  page.setDefaultTimeout(15_000);
  page.on('pageerror', (error) => report.errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') report.errors.push(message.text());
  });
  session = await page.context().newCDPSession(page);
  await expect(page.getByLabel('Message the resume agent')).toBeEnabled({ timeout: 120_000 });
  await expect(page.locator('.compiler-preparation')).toHaveCount(0, { timeout: 120_000 });
};
const listen = () =>
  page.evaluate(() => {
    window.editorInputEvents = [];
    for (const type of [
      'keydown',
      'keyup',
      'compositionstart',
      'compositionupdate',
      'compositionend',
      'beforeinput',
      'input',
    ]) {
      document.addEventListener(
        type,
        (event) => {
          if (!event.target?.closest?.('.cm-content')) return;
          window.editorInputEvents.push({
            type,
            data: event.data ?? null,
            key: event.key ?? null,
            inputType: event.inputType ?? null,
            isComposing: event.isComposing ?? null,
            trusted: event.isTrusted,
          });
        },
        true,
      );
    }
  });
const startCase = async (name, tail) => {
  await code();
  const initial = base + `% ${name}: ${tail}`;
  await editor().press('ControlOrMeta+A');
  await page.keyboard.insertText(initial);
  await settleSource(initial);
  await editor().press('ControlOrMeta+End');
  // Separate fixture replacement from the subsequent user-edit history group.
  await new Promise((resolve) => setTimeout(resolve, 650));
  await page.evaluate(() => {
    window.editorInputEvents = [];
  });
  return initial;
};
const composition = (text) =>
  session.send('Input.imeSetComposition', {
    text,
    selectionStart: text.length,
    selectionEnd: text.length,
  });
const roundTrip = async (expected) => {
  await chat();
  await settleSource(expected);
  await code();
  await editor().focus();
  await settleSource(expected);
};
const checkUndo = async (initial, final) => {
  let undos = 0;
  while ((await source()) !== initial && undos < 4) {
    const before = await source();
    await editor().press('ControlOrMeta+z');
    await expect.poll(source).not.toBe(before);
    undos++;
  }
  await settleSource(initial);
  for (let i = 0; i < undos; i++) await editor().press('ControlOrMeta+Shift+z');
  await settleSource(final);
  return undos;
};
const recordCase = async (name, initial, final, undos, compositionExpected = true) => {
  const events = await page.evaluate(() => window.editorInputEvents);
  if (compositionExpected) {
    expect(events.some((event) => event.type === 'compositionstart' && event.trusted)).toBe(true);
    expect(events.some((event) => event.type === 'compositionupdate' && event.trusted)).toBe(true);
    // Both the unchanged app and the candidate emit an untrusted end event
    // through this CDP path. Keep its actual trust bit in the evidence while
    // requiring native composition updates and exact source/undo round trips.
    expect(events.some((event) => event.type === 'compositionend')).toBe(true);
    expect(
      events.some((event) => event.type === 'input' && event.isComposing && event.trusted),
    ).toBe(true);
  } else {
    expect(events.some((event) => event.type === 'keydown' && event.trusted)).toBe(true);
    expect(events.some((event) => event.type === 'keyup' && event.trusted)).toBe(true);
  }
  report.cases.push({
    name,
    initial,
    final,
    sourceSha256: hash(Buffer.from(final)),
    undos,
    events,
  });
  await observe(name);
  console.log(`PASS: ${name}`);
};
const close = async () => {
  await session.detach();
  session = undefined;
  const closed = page.waitForEvent('close');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  await closed;
  await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
  await app.close().catch(() => {});
  app = undefined;
};
try {
  await launch();
  report.applicationVersions = await app.evaluate(() => ({ ...process.versions }));
  await page.getByText('Up to date', { exact: true }).waitFor({ timeout: 60_000 });
  await app.evaluate(({ dialog }, folder) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] });
  }, folder);
  await page.getByRole('button', { name: 'More project actions' }).click();
  await page.getByRole('menuitem', { name: 'Open project folder…', exact: true }).click();
  await expect(page.locator('.preview-pane .textLayer')).toContainText('Editor input fixture.', {
    timeout: 60_000,
  });
  await code();
  await page.getByLabel('Auto-compile', { exact: true }).uncheck();
  await listen();
  await observe('ready');

  let initial = await startCase('ordinary character keys', '');
  await page.keyboard.type('alpha beta gamma', { delay: 12 });
  let final = initial + 'alpha beta gamma';
  await settleSource(final);
  await roundTrip(final);
  await recordCase(
    'ordinary character keys',
    initial,
    final,
    await checkUndo(initial, final),
    false,
  );

  initial = await startCase('committed composition', '');
  await composition('にほん');
  await composition('日本語');
  await session.send('Input.insertText', { text: '日本語' });
  final = initial + '日本語';
  await settleSource(final);
  await roundTrip(final);
  await recordCase('committed composition', initial, final, await checkUndo(initial, final));

  initial = await startCase('composition interrupted by Chat', '');
  await composition('とうきょう');
  await composition('東京');
  await expect(editor()).toContainText('東京');
  // Deliberately switch while composition is still active, without an explicit
  // commit call or waiting for a recovery write before the view disappears.
  final = initial + '東京';
  await roundTrip(final);
  await recordCase(
    'composition interrupted by Chat',
    initial,
    final,
    await checkUndo(initial, final),
  );

  initial = await startCase('cancelled composition', '');
  await composition('とりけし');
  await composition('');
  await settleSource(initial);
  await roundTrip(initial);
  await page.keyboard.type('kept', { delay: 12 });
  final = initial + 'kept';
  await settleSource(final);
  await recordCase('cancelled composition', initial, final, await checkUndo(initial, final));

  initial = await startCase('composition replaces selection', 'old value');
  for (let i = 0; i < 'old value'.length; i++) await editor().press('Shift+ArrowLeft');
  expect(await page.evaluate(() => window.getSelection().toString())).toBe('old value');
  await composition('にほん');
  await composition('日本語');
  await session.send('Input.insertText', { text: '日本語' });
  final = initial.slice(0, -'old value'.length) + '日本語';
  await settleSource(final);
  await roundTrip(final);
  await recordCase(
    'composition replaces selection',
    initial,
    final,
    await checkUndo(initial, final),
  );

  await page.getByRole('button', { name: 'Compile', exact: true }).click();
  await page.getByText('Up to date', { exact: true }).waitFor({ timeout: 60_000 });
  await expect(page.locator('.preview-pane .textLayer')).toContainText('Editor input fixture.');
  await page.screenshot({ path: path.join(root, 'composition-restored.png') });
  await chat();
  await close();
  await launch();
  await settleSource(final);
  await code();
  await expect(editor()).toContainText('日本語');
  await editor().press('ControlOrMeta+End');
  await page.keyboard.type(' after restart', { delay: 12 });
  final += ' after restart';
  await settleSource(final);
  report.recoveredFinalSource = final;
  report.recoveredFinalSourceSha256 = hash(Buffer.from(final));
  await close();
  expect(hash(await fs.readFile(asar))).toBe(report.appAsarSha256);
  expect(hash(await fs.readFile(fileURLToPath(import.meta.url)))).toBe(report.scriptSha256);
  expect(report.errors).toEqual([]);
  report.passed = true;
  console.log(
    'PASS: completed source compiles, survives restart and accepts later character input.',
  );
} catch (error) {
  report.failure = error.message;
  report.currentSource = await source().catch(() => null);
  report.currentEvents = await page?.evaluate(() => window.editorInputEvents).catch(() => []);
  await page?.screenshot({ path: path.join(root, 'failure.png') }).catch(() => {});
  throw error;
} finally {
  await session?.detach().catch(() => {});
  await app?.evaluate(({ app }) => app.exit(0)).catch(() => {});
  await app?.close().catch(() => {});
  report.finishedAt = new Date().toISOString();
  await fs.writeFile(path.join(root, 'result.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(`Evidence: ${root}`);
}
