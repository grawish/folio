import { _electron as electron, expect } from '@playwright/test';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const root = await fs.mkdtemp(path.resolve('test-results/pdf-viewer-'));
const env = { ...process.env, FOLIO_USER_DATA: path.join(root, 'data') };
// Optional test-owned verified runtime copies speed failed-test iterations.
// The default qualification path always prepares a fresh runtime.
if (process.env.FOLIO_TEST_RUNTIME_SEED) {
  await fs.mkdir(env.FOLIO_USER_DATA, { recursive: true });
  await fs.cp(
    path.resolve(process.env.FOLIO_TEST_RUNTIME_SEED),
    path.join(env.FOLIO_USER_DATA, 'runtimes'),
    { recursive: true },
  );
}
delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({
  ...(process.argv[2]
    ? { executablePath: path.resolve(process.argv[2]), args: [] }
    : { args: [process.cwd()] }),
  env,
  timeout: 60_000,
});
let page;
const errors = [],
  measurements = [];
// Small genuine PDFs with controlled MediaBox values exercise geometry without
// depending on an unrelated TeX package's custom-paper commands.
const geometryPdf = (sizes) => {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Count ${sizes.length} /Kids [${sizes.map((_, i) => `${3 + i * 2} 0 R`).join(' ')}] >>`,
  ];
  for (const [width, height] of sizes) {
    const content = `0.2 0.7 0.8 rg 20 20 ${width - 40} ${height - 40} re f`;
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] /Resources << >> /Contents ${objects.length + 2} 0 R >>`,
    );
    objects.push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
  }
  let result = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, i) => {
    offsets.push(result.length);
    result += `${i + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = result.length;
  result += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  result += offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`)
    .join('');
  result += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return [...new TextEncoder().encode(result)];
};
const replaceNextPdf = (kind, bytes = []) =>
  app.evaluate(
    ({ ipcMain }, { kind, bytes }) => {
      const original = ipcMain._invokeHandlers.get('build:compile');
      ipcMain._invokeHandlers.set('build:compile', async (...args) => {
        ipcMain._invokeHandlers.set('build:compile', original);
        const result = await original(...args);
        return {
          ...result,
          pdf: kind === 'oversized' ? new Uint8Array(25 * 1024 * 1024 + 1) : new Uint8Array(bytes),
        };
      });
    },
    { kind, bytes },
  );
const source = (count, label = 'Viewer page') =>
  String.raw`\documentclass{article}
\usepackage{hyperref}
\begin{document}
` +
  Array.from(
    { length: count },
    (_, i) => String.raw`\section*{${label} ${i + 1}}
Readable source on page ${i + 1}. \href{https://example.com/${i + 1}}{Page link}
`,
  ).join('\n\\newpage\n') +
  '\\end{document}';
const compile = async (text) => {
  // CodeMirror virtualizes a long source document. Filling the contenteditable
  // can replace only its rendered DOM range after scrolling; its select-all
  // command selects the complete editor document instead.
  await page.locator('.cm-content').focus();
  await page.keyboard.press('Meta+A');
  await page.keyboard.insertText(text);
  await page.getByRole('button', { name: 'Compile', exact: true }).click();
};
const sheet = (number) => page.locator(`.preview-pane .pdf-sheet[data-page="${number}"]`);
const go = async (number, label = 'Viewer page') => {
  await sheet(number).evaluate((node) => node.scrollIntoView({ block: 'start' }));
  await expect(sheet(number).locator('.textLayer')).toContainText(`${label} ${number}`);
  await expect(page.locator('.page-controls')).toContainText(`${number} /`);
};
const measure = async (label) => {
  const result = await page.locator('.preview-pane').evaluate((node) => {
    const canvases = [...node.querySelectorAll('.pdf-sheet canvas')];
    return {
      pages: node.querySelectorAll('.pdf-sheet').length,
      renderedPages: node.querySelectorAll('.pdf-sheet > canvas').length,
      canvases: canvases.length,
      pixels: canvases.reduce((total, c) => total + c.width * c.height, 0),
      largest: Math.max(...canvases.map((c) => c.width * c.height)),
      side: Math.max(...canvases.flatMap((c) => [c.width, c.height])),
    };
  });
  expect(result.pixels).toBeLessThanOrEqual(16 * 1024 * 1024);
  expect(result.largest).toBeLessThanOrEqual(4 * 1024 * 1024);
  expect(result.side).toBeLessThanOrEqual(8192);
  expect(result.renderedPages).toBeLessThanOrEqual(5);
  expect(result.canvases).toBeLessThanOrEqual(10);
  measurements.push({ label, ...result });
};
const noExport = async () => {
  const before = await app.evaluate(() => globalThis.pdfSaveDialogs);
  await page.getByRole('button', { name: 'Export PDF', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Export PDF', exact: true })).toBeEnabled();
  expect(await app.evaluate(() => globalThis.pdfSaveDialogs)).toBe(before);
};
try {
  page = await app.firstWindow();
  page.setDefaultTimeout(20_000);
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (item) => {
    if (item.type() === 'error') errors.push(item.text());
  });
  await expect(page.getByLabel('Message the resume agent')).toBeEnabled({ timeout: 120_000 });
  await page.getByText('Up to date', { exact: true }).waitFor({ timeout: 60_000 });
  await page.evaluate(() => {
    const OriginalWorker = window.Worker;
    window.pdfWorkers = new Set();
    window.pdfWorkersCreated = 0;
    window.Worker = class extends OriginalWorker {
      constructor(...args) {
        super(...args);
        window.pdfWorkers.add(this);
        window.pdfWorkersCreated++;
      }
      terminate() {
        super.terminate();
        window.pdfWorkers.delete(this);
      }
    };
  });
  await page.getByRole('tab', { name: 'Code', exact: true }).click();
  await page.getByLabel('Auto-compile', { exact: true }).uncheck();
  await app.evaluate(({ dialog }) => {
    globalThis.pdfSaveDialogs = 0;
    dialog.showSaveDialog = async () => {
      globalThis.pdfSaveDialogs++;
      return { canceled: true };
    };
  });

  await compile(source(35));
  await expect(page.locator('.preview-pane .pdf-sheet')).toHaveCount(35, { timeout: 60_000 });
  await go(1);
  await measure('35-page first view');
  await sheet(1)
    .locator(':scope > canvas')
    .evaluate((canvas) => {
      window.retiredCanvas = canvas;
    });
  await go(35);
  await expect
    .poll(() =>
      page.evaluate(() => ({
        connected: window.retiredCanvas.isConnected,
        width: window.retiredCanvas.width,
        height: window.retiredCanvas.height,
      })),
    )
    .toEqual({ connected: false, width: 0, height: 0 });
  await expect(sheet(35).locator('.pdf-links a')).toHaveAttribute('href', 'https://example.com/35');
  await measure('35-page last view');
  for (const number of [12, 1, 30, 2, 35]) await go(number);
  await page.getByRole('button', { name: 'Previous page', exact: true }).click();
  await expect(page.locator('.page-controls')).toContainText('34 / 35');
  await expect(sheet(34).locator('.textLayer')).toContainText('Viewer page 34');
  await go(35);
  console.log(
    'PASS: 35-page PDF renders only visible neighbours; offscreen canvases release their backing surfaces; scroll, buttons, text and links work.',
  );

  await page.getByRole('button', { name: 'Add a PDF note', exact: true }).click();
  const bounds = await sheet(35).boundingBox();
  await page.mouse.click(bounds.x + bounds.width * 0.4, bounds.y + 160);
  await page.getByLabel('PDF note instructions').fill('Keep this note on page thirty-five.');
  await page.getByRole('button', { name: 'Save note', exact: true }).click();
  await go(1);
  await go(35);
  await expect(sheet(35).locator('.pdf-note-marker')).toHaveCount(1);
  await page.screenshot({ path: path.join(root, 'long-document-note.png') });

  await page.evaluate(() =>
    Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: 4 }),
  );
  for (let i = 0; i < 8; i++)
    await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
  await expect(page.locator('.zoom-controls')).toContainText('180%');
  await expect(sheet(35).locator('.textLayer')).toContainText('Viewer page 35');
  await measure('4x device ratio at 180% zoom');
  await page.evaluate(() =>
    Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: 1 }),
  );
  await page.getByRole('button', { name: 'Fit to width', exact: true }).click();
  await go(35);
  console.log(
    'PASS: a far-page note survives eviction and return; simulated high-DPI/zoom canvases stay within per-page and total pixel budgets.',
  );

  await compile(source(101));
  await expect(page.locator('.preview-inner > [role="alert"]')).toContainText('100 pages', {
    timeout: 60_000,
  });
  await expect(page.locator('.preview-pane .pdf-sheet')).toHaveCount(35);
  await expect(sheet(35).locator('.textLayer')).toContainText('Viewer page 35');
  await expect(page.getByRole('toolbar', { name: 'PDF annotation tools' })).toHaveCount(0);
  await noExport();
  await page.screenshot({ path: path.join(root, 'page-limit.png') });
  await compile(source(100));
  await expect(page.locator('.preview-pane .pdf-sheet')).toHaveCount(100, { timeout: 60_000 });
  await go(100);
  await measure('100-page supported boundary');
  console.log(
    'PASS: 101 pages are refused before page rendering, preserving the old preview and preventing export; the 100-page boundary works.',
  );

  // Replace only the next IPC result with malformed/oversized bytes. The
  // actual source build and backend remain normal; no user files are touched.
  for (const [kind, expected, bytes] of [
    ['oversized', '25 MB', []],
    ['malformed', 'Invalid PDF', [...new TextEncoder().encode('%PDF-1.7\nbroken')]],
    ['geometry', 'unsupported size', geometryPdf([[400, 40000]])],
  ]) {
    await replaceNextPdf(kind, bytes);
    await compile(source(1, kind));
    await expect(page.locator('.preview-inner > [role="alert"]')).toContainText(expected, {
      timeout: 60_000,
    });
    await expect(page.locator('.preview-pane .pdf-sheet')).toHaveCount(100);
    await noExport();
  }
  console.log(
    'PASS: oversized, malformed and extreme-page PDF results preserve the previous document and cannot open the export dialog.',
  );

  await page.evaluate(() => {
    const original = Worker.prototype.postMessage;
    window.heldPdfLoad = false;
    window.heldPdfLoadTerminated = false;
    Worker.prototype.postMessage = function (...args) {
      if (args[0]?.action === 'GetDocRequest') {
        Worker.prototype.postMessage = original;
        window.heldPdfLoad = true;
        const terminate = this.terminate.bind(this);
        this.terminate = () => {
          window.heldPdfLoadTerminated = true;
          return terminate();
        };
        return;
      }
      return original.apply(this, args);
    };
  });
  await compile(source(1, 'Held load'));
  await expect.poll(() => page.evaluate(() => window.heldPdfLoad), { timeout: 60_000 }).toBe(true);
  await page.getByRole('button', { name: 'Export PDF', exact: true }).click();
  await expect(page.locator('.preview-inner > [role="alert"]')).toContainText('too long to open', {
    timeout: 20_000,
  });
  await expect.poll(() => page.evaluate(() => window.heldPdfLoadTerminated)).toBe(true);
  expect(await app.evaluate(() => globalThis.pdfSaveDialogs)).toBe(0);
  await expect(page.locator('.preview-pane .pdf-sheet')).toHaveCount(100);
  await compile(source(1, 'Recovered preview'));
  await expect(sheet(1).locator('.textLayer')).toContainText('Recovered preview 1', {
    timeout: 60_000,
  });
  await expect(page.locator('.preview-inner > [role="alert"]')).toHaveCount(0);
  await page.getByRole('button', { name: 'Export PDF', exact: true }).click();
  await expect.poll(() => app.evaluate(() => globalThis.pdfSaveDialogs)).toBe(1);
  console.log(
    'PASS: stalled PDF loading times out without dropping the previous preview; export waits and is rejected, then a normal rebuild restores export.',
  );

  await replaceNextPdf(
    'geometry',
    geometryPdf([
      [400, 800],
      [800, 400],
      [600, 900],
    ]),
  );
  await compile(source(1, 'Mixed paper fixture'));
  await expect(page.locator('.preview-pane .pdf-sheet')).toHaveCount(3, { timeout: 60_000 });
  const proportions = await page.locator('.preview-pane .pdf-sheet').evaluateAll((nodes) =>
    nodes.map((node) => {
      const b = node.getBoundingClientRect();
      return b.height / b.width;
    }),
  );
  for (const [i, ratio] of [2, 0.5, 1.5].entries()) expect(proportions[i]).toBeCloseTo(ratio, 2);
  await sheet(3).evaluate((node) => node.scrollIntoView({ block: 'start' }));
  await expect(page.locator('.page-controls')).toContainText('3 / 3');
  await expect(page.locator('.preview-scroll')).toHaveAttribute('aria-busy', 'false');
  await page.screenshot({ path: path.join(root, 'mixed-paper.png') });

  await page.evaluate(() => {
    const original = Worker.prototype.postMessage;
    window.heldPdfRender = false;
    window.heldPdfRenderTerminated = false;
    Worker.prototype.postMessage = function (...args) {
      if (args[0]?.action === 'GetOperatorList') {
        Worker.prototype.postMessage = original;
        window.heldPdfRender = true;
        const terminate = this.terminate.bind(this);
        this.terminate = () => {
          window.heldPdfRenderTerminated = true;
          return terminate();
        };
        return;
      }
      return original.apply(this, args);
    };
  });
  await compile(source(1, 'Held render'));
  await expect
    .poll(() => page.evaluate(() => window.heldPdfRender), { timeout: 60_000 })
    .toBe(true);
  await page.getByRole('button', { name: 'Export PDF', exact: true }).click();
  await expect(page.locator('.preview-inner > [role="alert"]')).toContainText(
    'too long to render',
    { timeout: 20_000 },
  );
  await expect.poll(() => page.evaluate(() => window.heldPdfRenderTerminated)).toBe(true);
  await expect(page.locator('.preview-pane .pdf-sheet')).toHaveCount(3);
  await expect(page.locator('.page-controls')).toContainText('3 / 3');
  expect(await app.evaluate(() => globalThis.pdfSaveDialogs)).toBe(1);
  await compile(source(1, 'Final preview'));
  await expect(sheet(1).locator('.textLayer')).toContainText('Final preview 1', {
    timeout: 60_000,
  });
  await expect(page.locator('.preview-scroll')).toHaveAttribute('aria-busy', 'false');
  for (const [width, height] of [
    [1040, 680],
    [1480, 960],
    [1040, 680],
  ]) {
    await app.evaluate(
      ({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setSize(...size),
      [width, height],
    );
    await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(width);
    await expect(sheet(1).locator('.textLayer')).toContainText('Final preview 1');
    await expect(page.locator('.preview-scroll')).toHaveAttribute('aria-busy', 'false');
    // A fit-to-width scrollbar loop can briefly report ready before restarting.
    // Check settled geometry and readiness across time, not just one frame.
    const samples = await page.locator('.preview-scroll').evaluate(async (node) => {
      const samples = [];
      for (let i = 0; i < 20; i++) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        samples.push({
          width: node.querySelector('.pdf-sheet > canvas').width,
          busy: node.getAttribute('aria-busy'),
        });
      }
      return samples;
    });
    expect(new Set(samples.map((s) => s.width)).size).toBe(1);
    expect(samples.every((s) => s.busy === 'false')).toBe(true);
  }
  await page.getByRole('button', { name: 'Export PDF', exact: true }).click();
  await expect.poll(() => app.evaluate(() => globalThis.pdfSaveDialogs)).toBe(2);
  const notification = page.getByRole('button', { name: 'Dismiss notification', exact: true });
  if (await notification.isVisible()) await notification.click();
  await expect.poll(() => page.evaluate(() => window.pdfWorkers.size)).toBe(1);
  const workers = await page.evaluate(() => ({
    created: window.pdfWorkersCreated,
    remaining: window.pdfWorkers.size,
  }));
  expect(workers.created).toBeGreaterThan(8);
  await page.screenshot({ path: path.join(root, 'small-preview.png') });
  console.log(
    'PASS: mixed paper sizes keep exact dimensions; stalled page rendering blocks export, times out, and a normal rebuild recovers.',
  );
  console.log(
    'PASS: replaced and failed PDF workers terminate; only the current preview worker remains.',
  );
  expect(errors).toEqual([]);
  await fs.writeFile(
    path.join(root, 'result.json'),
    JSON.stringify({ passed: true, errors, measurements, workers }, null, 2),
  );
  console.log(`Evidence: ${root}`);
} catch (error) {
  await page?.screenshot({ path: path.join(root, 'failure.png') }).catch(() => {});
  await fs.writeFile(
    path.join(root, 'result.json'),
    JSON.stringify({ passed: false, errors, measurements, error: String(error) }, null, 2),
  );
  console.error(`Evidence: ${root}`);
  throw error;
} finally {
  await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
  await app.close().catch(() => {});
}
