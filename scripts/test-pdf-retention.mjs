// Repeats one-page → 100-page → full scroll → one-page PDF replacements in the
// real PdfPreview inside Electron (PERF-02 long-PDF workload) and requires the
// viewer to stay bounded: one live PDF worker and blob URL, no growing detached
// DOM, windowed canvases and a flat collected JS heap. It then samples renderer
// CPU across idle windows as a PERF-01 diagnostic; idle CPU is reported, not gated.
import { _electron as electron } from '@playwright/test';
import { build } from 'vite';
import react from '@vitejs/plugin-react';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const cycles = Number(process.env.FOLIO_PDF_RETENTION_CYCLES ?? 20);
const every = Math.max(1, Math.floor(cycles / 4));
const out = path.resolve('test-results/pdf-retention');
const src = path.resolve('src');
await fs.rm(out, { recursive: true, force: true });
await fs.mkdir(out, { recursive: true });

await fs.writeFile(
  path.join(out, 'index.html'),
  '<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;height:100%}#root{width:900px;height:800px;display:flex;flex-direction:column}#root>*{flex:1;min-height:0}</style></head><body><div id="root"></div><script type="module" src="./main.tsx"></script></body></html>',
);
await fs.writeFile(
  path.join(out, 'main.tsx'),
  `import React, { useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { PdfPreview, type PdfPreviewHandle } from ${JSON.stringify(path.join(src, 'components/PdfPreview'))};
import ${JSON.stringify(path.join(src, 'styles.css'))};
import ${JSON.stringify(path.join(src, 'chat.css'))};

// Count live PDF workers and blob URLs owned by the viewer.
const live = { workers: 0, blobs: 0 };
const NativeWorker = window.Worker;
window.Worker = class extends NativeWorker {
  constructor(url: string | URL, options?: WorkerOptions) {
    super(url, options);
    live.workers++;
  }
  terminate() {
    live.workers--;
    super.terminate();
  }
};
const createUrl = URL.createObjectURL;
const revokeUrl = URL.revokeObjectURL;
URL.createObjectURL = (blob: Blob | MediaSource) => {
  live.blobs++;
  return createUrl(blob);
};
URL.revokeObjectURL = (url: string) => {
  live.blobs--;
  revokeUrl(url);
};

// A minimal text PDF: each page has 45 lines of Helvetica text.
function makePdf(pages: number, tag: string) {
  const objects: string[] = [];
  const kids: number[] = [];
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';
  let next = 4;
  for (let page = 0; page < pages; page++) {
    let stream = 'BT /F1 11 Tf 50 780 Td 14 TL';
    for (let line = 0; line < 45; line++)
      stream += ' (' + tag + ' page ' + (page + 1) + ' line ' + line + " synthetic resume text) '";
    stream += ' ET';
    objects[next] = '<< /Length ' + stream.length + ' >>\\nstream\\n' + stream + '\\nendstream';
    objects[next + 1] =
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents ' +
      next + ' 0 R >>';
    kids.push(next + 1);
    next += 2;
  }
  objects[2] = '<< /Type /Pages /Kids [' + kids.map((kid) => kid + ' 0 R').join(' ') + '] /Count ' + pages + ' >>';
  let pdf = '%PDF-1.4\\n';
  const offsets: number[] = [];
  for (let i = 1; i < next; i++) {
    offsets[i] = pdf.length;
    pdf += i + ' 0 obj\\n' + objects[i] + '\\nendobj\\n';
  }
  const xref = pdf.length;
  pdf += 'xref\\n0 ' + next + '\\n0000000000 65535 f \\n';
  for (let i = 1; i < next; i++) pdf += String(offsets[i]).padStart(10, '0') + ' 00000 n \\n';
  pdf += 'trailer\\n<< /Size ' + next + ' /Root 1 0 R >>\\nstartxref\\n' + xref + '\\n%%EOF\\n';
  return new TextEncoder().encode(pdf);
}

function Harness() {
  const preview = useRef<PdfPreviewHandle>(null);
  const [data, setData] = useState<Uint8Array>();
  Object.assign(window, {
    live,
    async show(pages: number, tag: string) {
      const bytes = makePdf(pages, tag);
      setData(bytes);
      await new Promise((resolve) => setTimeout(resolve, 0));
      await preview.current!.waitForPdf(bytes);
    },
  });
  return <PdfPreview ref={preview} data={data} building={false} stale={false} status={null} versionId="v" />;
}
createRoot(document.getElementById('root')!).render(<Harness />);
`,
);
await build({
  root: out,
  base: './',
  configFile: false,
  logLevel: 'warn',
  plugins: [react()],
  build: { outDir: path.join(out, 'dist'), emptyOutDir: true, chunkSizeWarningLimit: 4000 },
});
await fs.writeFile(
  path.join(out, 'main.cjs'),
  `const { app, BrowserWindow } = require('electron');
app.whenReady().then(() => {
  const win = new BrowserWindow({ width: 1000, height: 900, show: false });
  win.loadFile(${JSON.stringify(path.join(out, 'dist/index.html'))});
});
`,
);

const app = await electron.launch({ args: [path.join(out, 'main.cjs')] });
const rows = [];
const errors = [];
let probe;
const idle = [];
let versions;
try {
  versions = await app.evaluate(() => ({
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    platform: `${process.platform}-${process.arch}`,
  }));
  const page = await app.firstWindow();
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => message.type() === 'error' && errors.push(message.text()));
  await page.waitForFunction(() => 'show' in window);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Performance.enable');
  const renderer = async () =>
    app.evaluate(({ app }) =>
      app
        .getAppMetrics()
        .filter((process) => process.type === 'Tab')
        .reduce(
          (sum, process) => ({
            workingSetKiB: sum.workingSetKiB + process.memory.workingSetSize,
            cpuPercent: sum.cpuPercent + process.cpu.percentCPUUsage,
          }),
          { workingSetKiB: 0, cpuPercent: 0 },
        ),
    );
  const measure = async (label) => {
    await page.waitForTimeout(1500);
    await cdp.send('HeapProfiler.collectGarbage');
    await cdp.send('HeapProfiler.collectGarbage');
    const { metrics } = await cdp.send('Performance.getMetrics');
    const metric = Object.fromEntries(metrics.map((item) => [item.name, item.value]));
    const dom = await page.evaluate(() => {
      let connected = 1;
      const walker = document.createTreeWalker(document, NodeFilter.SHOW_ALL);
      while (walker.nextNode()) connected++;
      return { connected, canvases: document.querySelectorAll('canvas').length, ...live };
    });
    const process = await renderer();
    rows.push({
      label,
      heapMiB: +(metric.JSHeapUsedSize / 2 ** 20).toFixed(2),
      detached: metric.Nodes - dom.connected,
      ...dom,
      rendererWorkingSetMiB: Math.round(process.workingSetKiB / 1024),
    });
  };

  await page.evaluate(() => show(1, 'start'));
  await measure('start');
  for (let cycle = 1; cycle <= cycles; cycle++) {
    await page.evaluate((cycle) => show(1, 'a' + cycle), cycle);
    await page.evaluate((cycle) => show(100, 'b' + cycle), cycle);
    for (let step = 1; step <= 10; step++) {
      await page.evaluate((step) => {
        const scroller = document.querySelector('.preview-scroll');
        scroller.scrollTop = (scroller.scrollHeight * step) / 10;
      }, step);
      await page.waitForTimeout(80);
    }
    if (cycle === 1)
      probe = await page.evaluate(() => ({
        sheets: document.querySelectorAll('.pdf-sheet').length,
        canvases: document.querySelectorAll('canvas').length,
        viewportHeight: document.querySelector('.preview-scroll').clientHeight,
      }));
    await page.evaluate((cycle) => show(1, 'c' + cycle), cycle);
    if (cycle % every === 0 || cycle === cycles) await measure('cycle-' + cycle);
  }

  // Electron reports CPU use since the previous getAppMetrics call.
  await renderer();
  for (let window = 0; window < 6; window++) {
    await page.waitForTimeout(2500);
    idle.push(+(await renderer()).cpuPercent.toFixed(2));
  }
} finally {
  await app.close();
}

const first = rows[1] ?? rows[0];
const last = rows.at(-1);
const result = {
  cycles,
  versions,
  workload: 'one page → 100 pages → ten scroll steps → one page, explicit GC at checkpoints',
  probe100: probe,
  rows,
  heapGrowthAfterWarmupMiB: +(last.heapMiB - first.heapMiB).toFixed(2),
  idleRendererCpuPercent: idle,
  errors,
  passed:
    errors.length === 0 &&
    probe?.sheets === 100 &&
    probe.canvases < 10 &&
    rows.every((row) => row.workers === 1 && row.blobs === 1 && row.detached < 20) &&
    last.heapMiB - first.heapMiB < 2,
};
await fs.writeFile(path.join(out, 'result.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result, null, 2));
if (!result.passed) process.exit(1);
