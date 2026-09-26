import { _electron as electron, expect } from '@playwright/test';
import { promises as fs } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { unzipSync, strFromU8 } from 'fflate';

// A local protocol fixture replaces inference only. The renderer, IPC, credential
// store, agent loop, PDF image rendering, compiler and history all run normally.
const root = await fs.mkdtemp(path.resolve('test-results/chat-'));
const dataRoot = path.join(root, 'app-data'),
  saved = path.join(root, 'saved');
await fs.mkdir(saved);
const source = String.raw`\documentclass{article}
\usepackage[margin=1in]{geometry}
\begin{document}
\section*{Taylor Example}
Engineer with experience building accessible tools.
\section*{Experience}
Built a document preview for a school project.
\newpage
\section*{Projects}
Community library website. Kept the existing catalogue easy to search.
\end{document}`;
const requests = [];
let mode = 'edit',
  release = null,
  held = false;
const server = createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/v1/models') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ data: [{ id: 'fixture-fast' }, { id: 'fixture-model' }] }));
      return;
    }
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    const content = body.messages[1].content;
    const promptText = content.find((item) => item.type === 'text').text;
    const images = content.filter((item) => item.type === 'image_url');
    const send = (answer) => {
      if (res.destroyed) return;
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify({
          choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(answer) } }],
        }),
      );
    };
    if (!promptText.startsWith('{')) {
      requests.push({ type: 'connection-test', images });
      send({ color: 'red' });
      return;
    }
    const prompt = JSON.parse(promptText);
    const type = prompt.candidateSource ? 'review' : 'edit';
    requests.push({
      type,
      prompt,
      images,
      mode,
      url: req.url,
      authorization: req.headers.authorization,
      model: body.model,
    });
    if (type === 'review') {
      send({ approved: true, issues: [], message: 'Both pages are readable.' });
      return;
    }
    if (mode === 'fast') {
      send({
        message: 'Updated the wording.',
        needsInput: false,
        edits: [{ path: 'main.tex', search: 'accessible tools', replacement: 'inclusive tools' }],
      });
      return;
    }
    if (mode === 'error') {
      res.statusCode = 429;
      res.end('fixture limit');
      return;
    }
    if (mode === 'question') {
      send({ message: 'What year did you complete that project?', needsInput: true, edits: [] });
      return;
    }
    const answer = {
      message: 'Updated the heading and checked both PDF pages.',
      needsInput: false,
      edits: prompt.source.map((file) => ({
        ...file,
        content: file.content
          .replace('section*{Projects}', 'section*{Selected Projects}')
          .replace('section*{My Manual Heading}', 'section*{Selected Projects}')
          .replace(
            'section*{Selected Projects}',
            mode === 'slow' ? 'section*{Featured Projects}' : 'section*{Selected Projects}',
          ),
      })),
    };
    if (mode === 'slow') {
      held = true;
      release = () => {
        held = false;
        send(answer);
      };
      return;
    }
    send(answer);
  } catch (error) {
    res.statusCode = 500;
    res.end(String(error));
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const env = { ...process.env, FOLIO_USER_DATA: dataRoot };
delete env.ELECTRON_RUN_AS_NODE;
let app, page, projectId;
const errors = [];
const lifecycle = [];
let nativeOutput = '';
const event = (type, details = {}) =>
  lifecycle.push({ at: new Date().toISOString(), type, ...details });
const launch = async () => {
  event('launch-start');
  app = await electron.launch({
    ...(process.argv[2]
      ? { executablePath: path.resolve(process.argv[2]), args: [] }
      : { args: [process.cwd()] }),
    env,
    timeout: 60_000,
  });
  const child = app.process();
  event('launched', { pid: child.pid });
  child.on('exit', (code, signal) => event('process-exit', { pid: child.pid, code, signal }));
  for (const stream of [child.stdout, child.stderr])
    stream?.on('data', (chunk) => {
      nativeOutput = (nativeOutput + chunk.toString()).slice(-65_536);
    });
  page = await app.firstWindow();
  page.on('close', () => event('window-closed', { pid: child.pid }));
  page.on('crash', () => event('renderer-crashed', { pid: child.pid }));
  page.setDefaultTimeout(15_000);
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (item) => {
    if (item.type() === 'error') errors.push(item.text());
  });
  await expect(page.getByLabel('Message the resume agent')).toBeEnabled({ timeout: 120_000 });
  event('startup-ready', { pid: child.pid });
};
const ready = () => page.getByText('Up to date', { exact: true }).waitFor({ timeout: 60_000 });
const code = () => page.getByRole('tab', { name: 'Code', exact: true }).click();
const chat = () => page.getByRole('tab', { name: 'Chat', exact: true }).click();
const editor = () => page.locator('.cm-content');
const composer = () => page.getByRole('textbox', { name: 'Message the resume agent' });
const readWorkspace = () => page.evaluate((id) => window.folio.loadWorkspace(id), projectId);
const send = async (text) => {
  const focus = await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().map((window) => ({
      focused: window.isFocused(),
      contentsFocused: window.webContents.isFocused(),
      visible: window.isVisible(),
    })),
  );
  event('composer-fill', {
    focus,
    documentFocused: await page.evaluate(() => document.hasFocus()),
    modalOpen: await page.locator('dialog[open]').count(),
  });
  // Settings waits for pack cancellation before closing its native modal. A
  // textarea behind that modal cannot receive input even though it is enabled.
  await expect(page.locator('dialog[open]')).toHaveCount(0);
  await composer().fill(text);
  await expect(composer()).toHaveValue(text);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
};
const close = async () => {
  const closed = page.waitForEvent('close');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  await closed;
  await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
  await app.close().catch(() => {});
};
try {
  await launch();
  await ready();
  const duplicate = spawn(app.process().spawnfile, process.argv[2] ? [] : [process.cwd()], {
    env,
    stdio: 'ignore',
  });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      duplicate.kill('SIGKILL');
      reject(new Error('A second app process did not exit.'));
    }, 15_000);
    duplicate.on('error', reject);
    duplicate.on('exit', (code) => {
      clearTimeout(timeout);
      if (code === 0) resolve();
      else reject(new Error(`Second app process exited with ${code}.`));
    });
  });
  expect(await app.evaluate(({ app }) => app.hasSingleInstanceLock())).toBe(true);
  await expect(page.getByRole('tab', { name: 'Chat', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(editor()).toBeHidden();
  await code();
  await editor().fill(source);
  await ready();
  await expect(page.locator('.preview-pane .pdf-sheet')).toHaveCount(2);
  await page.getByRole('checkbox', { name: 'Auto-compile', exact: true }).uncheck();
  await app.evaluate(({ dialog }, saved) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [saved] });
  }, saved);
  await page.getByRole('button', { name: 'Save project', exact: true }).click();
  await page.getByText('Saved locally', { exact: true }).waitFor();
  projectId = JSON.parse(await fs.readFile(path.join(saved, 'resume.project.json'), 'utf8')).id;
  await chat();
  await page.getByRole('button', { name: 'Open Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Add connection', exact: true }).click();
  await page.getByLabel('Connection type', { exact: true }).selectOption('custom');
  await page.getByLabel('Connection name', { exact: true }).fill('Local vision fixture');
  await page
    .getByLabel('Base URL', { exact: true })
    .fill(`http://127.0.0.1:${server.address().port}/v1`);
  await page.getByLabel('Model', { exact: true }).fill('fixture-model');
  await page.getByLabel('Fast model', { exact: true }).fill('fixture-fast');
  await page.getByLabel('Capable model', { exact: true }).fill('fixture-model');
  await page.getByLabel(/^API key/).fill('folio-fixture-key');
  await page.getByRole('button', { name: 'Save connection', exact: true }).click();
  await expect(page.getByRole('radio')).not.toBeChecked();
  await page.getByRole('radio').click();
  await expect(page.getByRole('radio')).toBeChecked();
  expect(await fs.readFile(path.join(dataRoot, 'ai-connections.json'), 'utf8')).not.toContain(
    'folio-fixture-key',
  );
  await page.getByRole('button', { name: 'Test image support', exact: true }).click();
  await expect(page.getByText('Image support verified', { exact: true })).toBeVisible({
    timeout: 30_000,
  });
  await page.screenshot({ path: path.join(root, 'settings.png') });
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(page.getByLabel('Chat model', { exact: true })).toHaveValue('auto');
  await expect(
    page.getByRole('button', { name: 'Local vision fixture', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByLabel('Chat model').locator('option[value="model:fixture-fast"]'),
  ).toHaveCount(1);
  await page.getByLabel('Chat model').selectOption('model:fixture-fast');
  await expect(page.getByLabel('Chat model')).toHaveValue('model:fixture-fast');
  await expect(page.getByLabel('Chat model')).toBeEnabled();
  await page.getByLabel('Chat model').selectOption('auto');
  await expect(page.getByLabel('Chat model')).toHaveValue('auto');
  console.log(
    'PASS: Chat exposes Auto, connection default and discovered models; connection setup remains in Settings.',
  );

  // Draw all four note types using real pointer events, with normalized positions.
  for (const [i, tool] of [
    'Highlight an area',
    'Box an area',
    'Draw on PDF',
    'Add a PDF note',
  ].entries()) {
    await page.getByRole('button', { name: tool, exact: true }).click();
    const canvas = page.locator('.preview-pane .pdf-annotation-layer canvas').first();
    const bounds = await canvas.boundingBox();
    const x = bounds.x + bounds.width * 0.2,
      y = bounds.y + bounds.height * (0.18 + i * 0.07);
    await page.mouse.move(x, y);
    await page.mouse.down();
    if (i !== 3) await page.mouse.move(x + bounds.width * 0.42, y + 20, { steps: 8 });
    await page.mouse.up();
    await page.getByRole('textbox', { name: 'PDF note instructions' }).fill(`Feedback ${i + 1}`);
    await page.getByRole('button', { name: 'Save note', exact: true }).click();
  }
  await expect.poll(async () => (await readWorkspace()).annotations.length).toBe(4);
  const notesBefore = (await readWorkspace()).annotations;
  const cleanPath = path.join(root, 'clean-export.pdf');
  await app.evaluate(({ dialog }, filePath) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath });
  }, cleanPath);
  await page.getByRole('button', { name: 'Export PDF', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('exported');
  const cleanVersion = await page.evaluate(
    ({ id, versionId }) => window.folio.readVersion(id, versionId),
    { id: projectId, versionId: notesBefore[0].versionId },
  );
  expect(await fs.readFile(cleanPath)).toEqual(Buffer.from(Object.values(cleanVersion.pdf)));
  await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
  const markerPosition = await page
    .locator('.preview-pane .pdf-note-marker')
    .first()
    .evaluate((el) => {
      const marker = el.getBoundingClientRect(),
        sheet = el.closest('.pdf-sheet').getBoundingClientRect();
      return {
        x: (marker.x + marker.width / 2 - sheet.x) / sheet.width,
        y: (marker.y + marker.height / 2 - sheet.y) / sheet.height,
      };
    });
  expect(markerPosition.x).toBeCloseTo(notesBefore[0].rect.x, 2);
  expect(markerPosition.y).toBeCloseTo(notesBefore[0].rect.y, 2);
  await page.getByRole('button', { name: 'Fit to width', exact: true }).click();
  await page.getByRole('button', { name: 'Attach 4 to chat', exact: true }).click();
  await expect(page.locator('.chat-composer .chat-note')).toHaveCount(4);
  // The bounded attachment list loads each thumbnail as it is scrolled into view.
  for (const note of await page.locator('.chat-composer .chat-note').all()) {
    await note.scrollIntoViewIfNeeded();
    await expect(note.locator('img')).toHaveCount(1, { timeout: 20_000 });
  }
  await expect(page.locator('.chat-composer .chat-note-preview img')).toHaveCount(4, {
    timeout: 20_000,
  });
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setContentSize(1040, 680),
  );
  await expect
    .poll(async () => page.locator('.chat-composer .chat-notes').evaluate((el) => el.clientHeight))
    .toBeLessThanOrEqual(140);
  const attachmentSend = await page
    .getByRole('button', { name: 'Send', exact: true })
    .boundingBox();
  expect(attachmentSend.y + attachmentSend.height).toBeLessThan(680);
  expect(
    await page.getByRole('button', { name: 'Send', exact: true }).evaluate((el) => {
      const box = el.getBoundingClientRect();
      return el.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2));
    }),
  ).toBe(true);
  await page.screenshot({ path: path.join(root, 'small-attachments.png') });
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setContentSize(1480, 960),
  );
  // Removing or opening an attachment must never submit the surrounding form.
  await composer().fill('Make the Projects heading say Selected Projects.');
  await page.getByRole('button', { name: 'Remove attached note: Feedback 4', exact: true }).click();
  expect(requests.filter((item) => item.type === 'edit')).toHaveLength(0);
  await page.screenshot({ path: path.join(root, 'annotations.png') });
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.locator('.chat-message.assistant')).toContainText('Updated the heading', {
    timeout: 60_000,
  });
  await expect(page.locator('.preview-pane .textLayer').nth(1)).toContainText('Selected Projects');
  const editRequest = requests.find((item) => item.type === 'edit');
  const review = requests.find((item) => item.type === 'review');
  expect(editRequest.images).toHaveLength(5); // Both pages and three selected crops.
  expect(editRequest.authorization).toBe('Bearer folio-fixture-key');
  expect(editRequest.model).toBe('fixture-model');
  expect(editRequest.prompt.imageContext[0].notes.map((note) => note.text)).toEqual([
    'Feedback 1',
    'Feedback 2',
    'Feedback 3',
  ]);
  expect(editRequest.prompt.source[0].content).toBe(source);
  expect(review.prompt.pageCount).toBe(2);
  expect(review.images).toHaveLength(2);
  expect(review.prompt.pages[1].text).toContain('Selected Projects');
  for (const image of editRequest.images) expect(image.image_url.url.length).toBeGreaterThan(1000);
  await expect
    .poll(async () => (await readWorkspace()).versions.some((version) => version.verified))
    .toBe(true);
  await expect(page.locator('.preview-pane .pdf-note-marker')).toHaveCount(0);
  await code();
  await expect(editor()).toContainText('Selected Projects');
  await ready();
  await expect(page.locator('.stale-note')).toBeHidden();
  await page.getByRole('checkbox', { name: 'Auto-compile', exact: true }).check();
  await chat();
  await expect(page.locator('.chat-message.user .chat-note-preview img')).toHaveCount(3, {
    timeout: 30_000,
  });
  const dismissNotification = page.getByRole('button', { name: 'Dismiss notification' });
  if (await dismissNotification.isVisible()) await dismissNotification.click();
  await page.screenshot({ path: path.join(root, 'chat-workspace.png') });
  console.log(
    'PASS: all annotation tools, zoom alignment, selected image crops, every-page review, and checked edits applied to a real PDF.',
  );

  await page.getByRole('button', { name: 'Compare changes', exact: true }).click();
  await expect(page.locator('.history-comparison .textLayer').last()).toContainText(
    'Selected Projects',
  );
  await expect(page.locator('.history-comparison .pdf-note-marker')).toHaveCount(4);
  await page.screenshot({ path: path.join(root, 'history.png') });
  await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await page.getByRole('button', { name: 'Discard changes', exact: true }).click();
  await ready();
  await code();
  await expect(editor()).toContainText('section*{Projects}');
  await expect(editor()).not.toContainText('Selected Projects');
  await chat();
  await page.getByRole('button', { name: 'History', exact: true }).click();
  await page
    .locator('.history-layout nav button')
    .filter({ hasText: 'Make the Projects heading say Selected Projects.' })
    .click();
  await page.getByRole('button', { name: 'Restore selected version', exact: true }).click();
  await ready();
  await expect(page.locator('.preview-pane .textLayer').nth(1)).toContainText('Selected Projects');
  console.log(
    'PASS: Undo and restoring a saved version restore the corresponding source and rebuild the PDF.',
  );
  // Follow an old PDF note from chat to its matching PDF version.
  await page.locator('.chat-message.user .chat-note button').first().click();
  await expect(page.getByRole('dialog', { name: 'Version history' })).toBeVisible();
  await expect(page.locator('.history-comparison .history-note')).toHaveCount(4);
  await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
  mode = 'question';
  await send('Add my graduation year.');
  await expect(page.locator('.chat-message.assistant').last()).toContainText('What year', {
    timeout: 60_000,
  });
  await expect(page.locator('.preview-pane .textLayer').nth(1)).toContainText('Selected Projects');
  console.log(
    'PASS: version comparison, old-note navigation and missing-fact questions without source changes.',
  );

  mode = 'slow';
  held = false;
  await send('Try a new heading.');
  await expect.poll(() => held, { timeout: 60_000 }).toBe(true);
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await expect(page.locator('.chat-message.assistant').last()).toContainText('Stopped', {
    timeout: 15_000,
  });
  release?.();
  await expect(page.locator('.preview-pane .textLayer').nth(1)).toContainText('Selected Projects');

  held = false;
  await send('Try a new heading again.');
  await expect.poll(() => held, { timeout: 60_000 }).toBe(true);
  await code();
  await editor().fill(source.replace('section*{Projects}', 'section*{My Manual Heading}'));
  release();
  await chat();
  await expect(page.locator('.chat-message.assistant').last()).toContainText(
    'kept your newer edits',
    { timeout: 60_000 },
  );
  await code();
  await expect(editor()).toContainText('My Manual Heading');
  await chat();
  await expect
    .poll(async () => (await readWorkspace()).versions.filter((version) => version.verified).length)
    .toBeGreaterThanOrEqual(2);
  console.log(
    'PASS: cancellation keeps the original; a completed AI draft cannot overwrite newer manual edits.',
  );

  held = false;
  const beforeOutsideReply = await page.locator('.chat-message.assistant').count();
  await send('Try a heading while the project changes outside the app.');
  await expect.poll(() => held, { timeout: 60_000 }).toBe(true);
  const beforeOutside = await fs.readFile(path.join(saved, 'main.tex'));
  await fs.writeFile(path.join(saved, 'main.tex'), source.replace('Projects', 'Outside Projects'));
  await expect(page.getByRole('region', { name: 'External file changes' })).toBeVisible();
  release();
  await expect(page.locator('.chat-message.assistant')).toHaveCount(beforeOutsideReply + 1, {
    timeout: 60_000,
  });
  await expect(page.locator('.chat-message.assistant').last()).toContainText(
    'kept your newer edits',
    { timeout: 60_000 },
  );
  await code();
  await expect(editor()).toContainText('My Manual Heading');
  await fs.writeFile(path.join(saved, 'main.tex'), beforeOutside);
  await expect(page.getByRole('region', { name: 'External file changes' })).toHaveCount(0);
  await chat();
  console.log(
    'PASS: outside file changes invalidate an in-flight AI result without replacing editor text.',
  );

  // Suppress watcher delivery to exercise the final disk check independently of
  // native event timing. The real project scanner and agent still run normally.
  held = false;
  const beforeUnreportedReply = await page.locator('.chat-message.assistant').count();
  await send('Try another heading while file notifications are delayed.');
  await expect.poll(() => held, { timeout: 60_000 }).toBe(true);
  await page.evaluate(() => window.folio.watchProject(null));
  await fs.writeFile(path.join(saved, 'main.tex'), source.replace('Projects', 'Delayed Outside'));
  await expect(page.getByRole('region', { name: 'External file changes' })).toHaveCount(0);
  release();
  await expect(page.locator('.chat-message.assistant')).toHaveCount(beforeUnreportedReply + 1, {
    timeout: 60_000,
  });
  await expect(page.locator('.chat-message.assistant').last()).toContainText(
    'kept your newer edits',
  );
  await code();
  await expect(editor()).toContainText('My Manual Heading');
  await fs.writeFile(path.join(saved, 'main.tex'), beforeOutside);
  await page.evaluate((id) => window.folio.watchProject(id), projectId);
  await expect(page.getByRole('region', { name: 'External file changes' })).toHaveCount(0);
  await chat();
  console.log('PASS: the final disk check protects outside edits even without a watcher event.');

  mode = 'error';
  await send('Try once more.');
  await expect(page.locator('.chat-message.assistant').last()).toContainText('usage limit', {
    timeout: 60_000,
  });
  await page.getByRole('button', { name: 'Edit and retry', exact: true }).click();
  await expect(composer()).toHaveValue('Try once more.');
  await composer().fill('Keep this unsent draft.');
  // A damaged history must be rejected before any source or manifest replacement.
  const protectedFiles = ['main.tex', 'resume.project.json', 'resume.folio'];
  const diskBefore = await Promise.all(
    protectedFiles.map((name) => fs.readFile(path.join(saved, name))),
  );
  const savedVersions = (await readWorkspace()).versions;
  const versionPdf = path.join(
    dataRoot,
    'workspaces',
    projectId,
    'versions',
    savedVersions[0].id,
    'resume.pdf',
  );
  const originalPdf = await fs.readFile(versionPdf);
  try {
    await fs.appendFile(versionPdf, '\nChanged outside the app');
    await page.getByRole('button', { name: 'Save project', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('damaged');
    for (const [index, name] of protectedFiles.entries())
      expect(await fs.readFile(path.join(saved, name))).toEqual(diskBefore[index]);
  } finally {
    await fs.writeFile(versionPdf, originalPdf);
  }
  console.log(
    'PASS: damaged history rejects Save before source, metadata or the prior history archive changes.',
  );
  await page.getByRole('button', { name: 'Save project', exact: true }).click();
  await page.getByText('Saved locally', { exact: true }).waitFor();
  await expect.poll(async () => (await readWorkspace()).draft).toBe('Keep this unsent draft.');
  const before = await readWorkspace();
  const originalId = projectId;
  const copied = path.join(root, 'copied');
  await fs.mkdir(copied);
  await app.evaluate(({ dialog }, selected) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] });
  }, copied);
  await page.getByRole('button', { name: 'More project actions', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Save project as…', exact: true }).click();
  await expect
    .poll(async () =>
      fs
        .readFile(path.join(copied, 'resume.project.json'), 'utf8')
        .then((text) => JSON.parse(text).id)
        .catch(() => originalId),
    )
    .not.toBe(originalId);
  projectId = JSON.parse(await fs.readFile(path.join(copied, 'resume.project.json'), 'utf8')).id;
  await expect(composer()).toHaveValue('Keep this unsent draft.');
  await expect
    .poll(async () => (await readWorkspace()).messages.length)
    .toBe(before.messages.length);
  await composer().fill('Draft in copied project.');
  await expect.poll(async () => (await readWorkspace()).draft).toBe('Draft in copied project.');
  expect((await page.evaluate((id) => window.folio.loadWorkspace(id), originalId)).draft).toBe(
    'Keep this unsent draft.',
  );
  const zipPath = path.join(root, 'source.zip');
  await app.evaluate(({ dialog }, filePath) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath });
  }, zipPath);
  await page.getByRole('button', { name: 'More project actions', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Export LaTeX source…', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('ZIP archive');
  const archive = unzipSync(await fs.readFile(zipPath));
  const historyArchive = unzipSync(archive['resume.folio']);
  const exportedHistory = JSON.parse(strFromU8(historyArchive['state.json']));
  expect(exportedHistory.projectId).toBe(JSON.parse(strFromU8(archive['resume.project.json'])).id);
  expect(exportedHistory.messages).toHaveLength(before.messages.length);
  expect(exportedHistory.draft).toBe('Draft in copied project.');
  expect(strFromU8(archive['main.tex'])).toContain('My Manual Heading');
  expect(JSON.stringify(exportedHistory)).not.toContain('folio-fixture-key');
  await app.evaluate(
    ({ dialog }, selected) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] });
    },
    path.join(saved, 'main.tex'),
  );
  await page.getByRole('button', { name: 'Open project', exact: true }).click();
  projectId = originalId;
  await ready();
  await expect(composer()).toHaveValue('Keep this unsent draft.');
  console.log(
    'PASS: Save As forks chat/history independently; source export includes matching history without AI credentials.',
  );
  await page.getByLabel('Chat model').selectOption('model:fixture-model');
  await expect(page.getByLabel('Chat model')).toBeEnabled();
  await close();
  await launch();
  await ready();
  await expect(page.getByLabel('Chat model')).toHaveValue('model:fixture-model');
  await expect(composer()).toHaveValue('Keep this unsent draft.');
  await expect(page.locator('.chat-message')).toHaveCount(before.messages.length);
  expect((await readWorkspace()).annotations).toEqual(before.annotations);
  expect((await readWorkspace()).versions.length).toBeGreaterThanOrEqual(before.versions.length);
  await expect(page.locator('.preview-pane .textLayer').nth(1)).toContainText('My Manual Heading');
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setContentSize(1040, 680),
  );
  await page.screenshot({ path: path.join(root, 'small-chat.png') });
  const clipped = await page
    .locator(
      '.workspace-tabs button, .chat-composer button, .annotation-tools button, .header-actions button',
    )
    .evaluateAll((elements) =>
      elements
        .filter((el) => {
          const r = el.getBoundingClientRect();
          return (
            r.width &&
            r.height &&
            (r.x < 0 ||
              r.y < 0 ||
              r.right > innerWidth + 1 ||
              r.bottom > innerHeight + 1 ||
              !el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)))
          );
        })
        .map((el) => el.textContent || el.getAttribute('aria-label')),
    );
  expect(clipped).toEqual([]);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByLabel('Appearance', { exact: true }).selectOption('light');
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.screenshot({ path: path.join(root, 'light-chat.png') });
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByLabel('Autosave project', { exact: true }).check();
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  mode = 'slow';
  held = false;
  await send('Hold this request while I type.');
  await expect.poll(() => held, { timeout: 60_000 }).toBe(true);
  const beforeAutosave = await fs.readFile(path.join(saved, 'main.tex'), 'utf8');
  const copyBeforeAutosave = await fs.readFile(path.join(copied, 'main.tex'), 'utf8');
  await code();
  await editor().press('ControlOrMeta+End');
  await page.keyboard.insertText('\n% Retained while AI is working');
  await new Promise((resolve) => setTimeout(resolve, 2700));
  expect(await fs.readFile(path.join(saved, 'main.tex'), 'utf8')).toBe(beforeAutosave);
  await chat();
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await expect(page.locator('.chat-message.assistant').last()).toContainText('Stopped');
  release?.();
  await expect
    .poll(() => fs.readFile(path.join(saved, 'main.tex'), 'utf8'), { timeout: 15_000 })
    .toContain('Retained while AI is working');
  expect(await fs.readFile(path.join(copied, 'main.tex'), 'utf8')).toBe(copyBeforeAutosave);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByLabel('Autosave project', { exact: true }).uncheck();
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  console.log(
    'PASS: autosave waits during AI work and resumes with retained manual edits after cancellation.',
  );
  mode = 'slow';
  held = false;
  await send('Keep this request through a restart.');
  await expect.poll(() => held, { timeout: 60_000 }).toBe(true);
  await close();
  release?.();
  await launch();
  await ready();
  await expect(page.locator('.chat-message.assistant').last()).toContainText(/Stopped|interrupted/);
  await code();
  await expect(editor()).toContainText('My Manual Heading');
  await chat();
  console.log(
    'PASS: clean PDF export excludes annotations; closing during a request restores an actionable conversation without changing source.',
  );
  mode = 'fast';
  const fastStart = requests.length;
  await page.getByLabel('Chat model').selectOption('auto');
  await expect(page.getByLabel('Chat model')).toBeEnabled();
  await send('Replace accessible tools with inclusive tools.');
  await expect(page.locator('.chat-message.assistant').last()).toContainText('Built successfully', {
    timeout: 60_000,
  });
  await expect(page.locator('.chat-message.assistant').last()).toContainText('fixture-fast');
  await expect(page.locator('.preview-pane .textLayer').first()).toContainText('inclusive tools');
  const fastRequests = requests.slice(fastStart).filter((r) => r.type !== 'connection-test');
  expect(fastRequests).toHaveLength(1);
  expect(fastRequests[0].images).toHaveLength(0);
  expect(fastRequests[0].model).toBe('fixture-fast');
  const fastWorkspace = await readWorkspace();
  const fastMessage = fastWorkspace.messages.at(-1);
  expect(fastMessage.execution.validation).toBe('compiled');
  expect(fastWorkspace.versions.find((v) => v.id === fastMessage.versionId).verified).toBe(false);
  await page.screenshot({ path: path.join(root, 'chat-model-picker.png') });
  await page.getByLabel('Chat model').selectOption('model:fixture-model');
  await expect(page.getByLabel('Chat model')).toBeEnabled();
  console.log(
    'PASS: a real PDF text edit uses one Fast model call, no input images, and compile-only History status.',
  );
  const closeCopy = path.join(root, 'copy-on-close');
  await fs.mkdir(closeCopy);
  await app.evaluate(({ dialog }) => {
    dialog.showOpenDialog = () =>
      new Promise((resolve) => {
        dialog.finishTestSave = resolve;
      });
  });
  await page.getByRole('button', { name: 'More project actions', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Save project as…', exact: true }).click();
  await page.getByText('Saving a copy…', { exact: true }).waitFor();
  await page.screenshot({ path: path.join(root, 'save-copy-pending.png') });
  const closedAfterSave = page.waitForEvent('close');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  await app.evaluate(({ dialog }, folder) => {
    dialog.finishTestSave({ canceled: false, filePaths: [folder] });
  }, closeCopy);
  await closedAfterSave;
  const closeSavedId = JSON.parse(
    await fs.readFile(path.join(closeCopy, 'resume.project.json'), 'utf8'),
  ).id;
  const closeRecovery = JSON.parse(await fs.readFile(path.join(dataRoot, 'recovery.json'), 'utf8'));
  expect(closeRecovery.project.id).toBe(closeSavedId);
  expect(closeRecovery.directory).toBe(await fs.realpath(closeCopy));
  expect(await fs.readFile(path.join(closeCopy, 'main.tex'), 'utf8')).toContain(
    'My Manual Heading',
  );
  console.log(
    'PASS: closing during Save As waits for the transaction and recovers the newly saved project identity.',
  );
  const savedAI = JSON.parse(await fs.readFile(path.join(dataRoot, 'ai-connections.json'), 'utf8'));
  expect(savedAI.connections.find((c) => c.id === savedAI.activeId).selection).toEqual({
    mode: 'manual',
    model: 'fixture-model',
  });
  expect(errors).toEqual([]);
  console.log(
    'PASS: actionable AI errors, retry draft, persistent chat/notes/history, recovery, compact controls and no renderer errors.',
  );
  console.log(`Evidence: ${root}`);
} catch (error) {
  event('test-failed', { message: error.message });
  console.error('Lifecycle:', JSON.stringify(lifecycle));
  console.error('Native output:', nativeOutput || 'none');
  console.error(
    'Composer state:',
    await page
      ?.evaluate(() => {
        const field = document.querySelector('textarea[aria-label="Message the resume agent"]');
        const button = document.querySelector('.chat-composer button[type="submit"]');
        return {
          draftLength: field?.value.length,
          documentFocused: document.hasFocus(),
          composerDisabled: field?.disabled,
          sendDisabled: button?.disabled,
          connectionNotice: !!document.querySelector('.chat-connection-notice'),
          progressVisible: !!document.querySelector('.agent-progress'),
        };
      })
      .catch(() => 'unavailable'),
  );
  console.error(
    'Visible build state:',
    await page
      ?.locator('.preview-state')
      .textContent()
      .catch(() => 'unavailable'),
  );
  console.error(
    'Diagnostics:',
    await page
      ?.locator('.diagnostics-panel')
      .textContent()
      .catch(() => 'none'),
  );
  await page?.screenshot({ path: path.join(root, 'failure.png') }).catch(() => {});
  throw error;
} finally {
  event('cleanup-start');
  await app?.evaluate(({ app }) => app.exit(0)).catch(() => {});
  await app?.close().catch(() => {});
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await fs.writeFile(path.join(root, 'lifecycle.json'), JSON.stringify(lifecycle, null, 2));
  await fs.writeFile(path.join(root, 'native-output.log'), nativeOutput);
}
