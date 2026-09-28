import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { expect } from '@playwright/test';

// Separate, explicitly collected diagnostics after normal sampling has stopped.
// Only called by the synthetic-profile harness, never from the application.
export async function captureRendererRetention({ page, session, root, cycles }) {
  const result = {
    scope:
      'Separate diagnostic after V8/native workload sampling. Explicit garbage collection and heap snapshots change collection behavior; these are not ordinary-session memory or timing acceptance measurements. Chat hides the mounted editor; creating a new synthetic project replaces its session and PDF. Full heap snapshots remain local.',
    observations: [],
    snapshots: [],
  };
  const observe = async (label) => {
    const connected = await page.evaluate(() => {
      const walker = document.createTreeWalker(document, NodeFilter.SHOW_ALL);
      let nodes = 1;
      while (walker.nextNode()) nodes++;
      return {
        nodes,
        elements: document.querySelectorAll('*').length,
        editors: document.querySelectorAll('.cm-editor').length,
        textLayers: document.querySelectorAll('.preview-pane .textLayer').length,
        canvases: document.querySelectorAll('.preview-pane canvas').length,
        codeHidden: document.querySelector('#workspace-code-panel')?.hidden,
      };
    });
    const observation = {
      label,
      at: new Date().toISOString(),
      connected,
      dom: await session.send('Memory.getDOMCounters'),
      memory: await session.send('Runtime.getHeapUsage'),
    };
    result.observations.push(observation);
    console.log(`Retention ${label}: ${JSON.stringify(observation)}`);
    return observation;
  };
  const snapshot = async (label) => {
    const chunks = [];
    let bytes = 0;
    const limit = 128 * 1024 * 1024;
    const onChunk = ({ chunk }) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes <= limit) chunks.push(chunk);
    };
    session.on('HeapProfiler.addHeapSnapshotChunk', onChunk);
    try {
      await session.send('HeapProfiler.takeHeapSnapshot', {
        reportProgress: false,
        captureNumericValue: false,
        exposeInternals: true,
      });
    } finally {
      session.off('HeapProfiler.addHeapSnapshotChunk', onChunk);
    }
    if (bytes > limit) throw new Error('Heap snapshot exceeds the 128 MiB diagnostic bound.');
    const data = Buffer.from(chunks.join(''));
    expect(data.length).toBe(bytes);
    const parsed = JSON.parse(data);
    expect(parsed.snapshot.node_count).toBeGreaterThan(0);
    const file = path.join(root, `${label}.heapsnapshot`);
    await fs.writeFile(file, data);
    result.snapshots.push({
      label,
      file,
      bytes,
      sha256: createHash('sha256').update(data).digest('hex'),
      nodes: parsed.snapshot.node_count,
      edges: parsed.snapshot.edge_count,
      parameters: { captureNumericValue: false, exposeInternals: true },
    });
    await observe(`${label}-after-snapshot`);
  };
  const collect = async (label) => {
    await observe(`${label}-before-gc`);
    await session.send('HeapProfiler.collectGarbage');
    await observe(`${label}-after-gc`);
    await snapshot(label);
  };
  try {
    await expect(page.locator('.preview-pane .textLayer')).toContainText(
      `Trace ${cycles} return page 1`,
    );
    await collect('code');
    await page.getByRole('tab', { name: 'Chat', exact: true }).click();
    await expect(page.locator('#workspace-code-panel')).toBeHidden();
    // The app deliberately preserves CodeMirror and its undo state across tabs.
    await expect(page.locator('.cm-editor')).toHaveCount(1);
    await collect('chat-existing-editor');
    const recovery = JSON.parse(await fs.readFile(path.join(root, 'app-data/recovery.json')));
    result.originalSyntheticProjectId = recovery.project.id;
    await page.getByRole('button', { name: 'Explore templates', exact: true }).click();
    await page.getByRole('button', { name: 'Create Classic resume', exact: true }).click();
    // Discard only the disposable synthetic draft in this verified profile copy.
    await page.getByRole('button', { name: 'Discard changes', exact: true }).click();
    await page.getByRole('tab', { name: 'Code', exact: true }).click();
    await page.getByRole('button', { name: 'Compile', exact: true }).click();
    await expect(page.locator('.preview-pane .textLayer')).toContainText('Alex Morgan');
    await page.getByText('Up to date', { exact: true }).waitFor();
    await expect
      .poll(async () => {
        const current = JSON.parse(await fs.readFile(path.join(root, 'app-data/recovery.json')));
        return current.project.id;
      })
      .not.toBe(result.originalSyntheticProjectId);
    await page.getByRole('tab', { name: 'Chat', exact: true }).click();
    await collect('new-project');
    result.completed = true;
    return result;
  } finally {
    await fs.writeFile(path.join(root, 'retention.json'), JSON.stringify(result, null, 2) + '\n');
  }
}
