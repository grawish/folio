// Checks that ordinary typing in the Code editor no longer leaves replaced
// CodeMirror DOM in Chromium's native undo stack (PERF-02), while typing, undo,
// autocompletion and IME composition keep their behavior. A native-input control
// in the same Electron runtime must still show the retention, so a passing result
// cannot come from a workload that never exercised the native editing path.
import { _electron as electron } from '@playwright/test';
import { build } from 'esbuild';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const cycles = Number(process.env.FOLIO_EDITOR_UNDO_CYCLES ?? 20);
const out = path.resolve('test-results/editor-native-undo');
await fs.rm(out, { recursive: true, force: true });
await fs.mkdir(out, { recursive: true });

await fs.writeFile(
  path.join(out, 'entry.ts'),
  `import { Compartment } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { createLatexEditorState } from ${JSON.stringify(path.resolve('src/editor-state.ts'))};
const lines = Array.from({ length: 60 }, (_, i) => '\\\\item Line ' + i + ' of a synthetic resume').join('\\n');
const view = new EditorView({
  state: createLatexEditorState({
    value: lines,
    filename: 'main.tex',
    dark: false,
    appearance: new Compartment(),
    attributes: new Compartment(),
    callbacks: { current: { onChange() {}, onCursor() {} } },
  }),
  parent: document.getElementById('root')!,
});
// The control keeps beforeinput away from the editor so Chromium applies text natively.
if (location.hash === '#native')
  window.addEventListener('beforeinput', (event) => event.stopImmediatePropagation(), true);
Object.assign(window, { view });
`,
);
await build({
  entryPoints: [path.join(out, 'entry.ts')],
  bundle: true,
  format: 'iife',
  outfile: path.join(out, 'bundle.js'),
  nodePaths: [path.resolve('node_modules')],
  logLevel: 'warning',
});
await fs.writeFile(
  path.join(out, 'index.html'),
  '<!doctype html><meta charset="utf-8"><div id="root" style="height:600px"></div><script src="bundle.js"></script>',
);
await fs.writeFile(
  path.join(out, 'main.cjs'),
  `const { app, BrowserWindow } = require('electron');
app.whenReady().then(() => {
  const win = new BrowserWindow({ width: 900, height: 700, show: false });
  win.loadFile(${JSON.stringify(path.join(out, 'index.html'))}, { hash: process.env.FOLIO_EDITOR_MODE });
});
`,
);

async function run(mode) {
  const app = await electron.launch({
    args: [path.join(out, 'main.cjs')],
    env: { ...process.env, FOLIO_EDITOR_MODE: mode },
  });
  try {
    const page = await app.firstWindow();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.waitForFunction(() => 'view' in window);
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Performance.enable');
    const doc = () => page.evaluate(() => view.state.doc.toString());
    const nodes = async () => {
      await cdp.send('HeapProfiler.collectGarbage');
      await cdp.send('HeapProfiler.collectGarbage');
      const { metrics } = await cdp.send('Performance.getMetrics');
      const counted = metrics.find((metric) => metric.name === 'Nodes').value;
      const connected = await page.evaluate(() => {
        let count = 1;
        const walker = document.createTreeWalker(document, NodeFilter.SHOW_ALL);
        while (walker.nextNode()) count++;
        return count;
      });
      return { counted, connected, detached: counted - connected };
    };

    await page.click('.cm-content');
    const start = await nodes();
    let expected = '';
    for (let cycle = 0; cycle < cycles; cycle++) {
      await page.keyboard.press('ControlOrMeta+a');
      const text = Array.from(
        { length: 60 },
        (_, i) => `\\item Cycle ${cycle} line ${i} of a synthetic resume`,
      ).join('\n');
      await page.keyboard.insertText(text);
      await page.keyboard.press('ControlOrMeta+End');
      await page.keyboard.type(' typed words');
      expected = text + ' typed words';
    }
    const end = await nodes();
    const typedOk = (await doc()) === expected;

    await page.keyboard.press('ControlOrMeta+z');
    const undone = await doc();
    const undoOk = undone !== expected && expected.startsWith(undone);

    await page.keyboard.press('ControlOrMeta+End');
    await page.keyboard.type('\n\\te');
    await page.locator('.cm-tooltip-autocomplete').waitFor({ timeout: 2000 });
    await page.keyboard.press('Escape');

    await page.keyboard.press('ControlOrMeta+End');
    await cdp.send('Input.imeSetComposition', {
      text: 'にほん',
      selectionStart: 3,
      selectionEnd: 3,
    });
    await cdp.send('Input.insertText', { text: '日本' });
    await page.keyboard.type('é😀');
    await page.waitForTimeout(100);
    const unicodeOk = (await doc()).endsWith('\\te日本é😀');

    return {
      mode,
      start,
      end,
      detachedGrowthPerCycle: (end.detached - start.detached) / cycles,
      typedOk,
      undoOk,
      unicodeOk,
      errors,
    };
  } finally {
    await app.close();
  }
}

const native = await run('native');
const managed = await run('managed');
const result = {
  cycles,
  native,
  managed,
  passed:
    native.detachedGrowthPerCycle > 100 &&
    managed.detachedGrowthPerCycle < 5 &&
    [native, managed].every(
      (item) => item.typedOk && item.undoOk && item.unicodeOk && item.errors.length === 0,
    ),
};
await fs.writeFile(path.join(out, 'result.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result, null, 2));
if (!result.passed) process.exit(1);
