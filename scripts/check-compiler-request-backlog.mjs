import { promises as fs } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';
import { tsImport } from 'tsx/esm/api';
const { Compiler } = await tsImport('../electron/core/compiler.ts', import.meta.url);
const root = await fs.mkdtemp(path.resolve('test-results/compiler-request-backlog-'));
let release,
  entered,
  acquired = 0,
  released = 0,
  settled = 0;
const entry = new Promise((r) => (entered = r)),
  hold = new Promise((r) => (release = r));
const runtime = {
  acquire: async () => {
    acquired++;
    if (acquired === 1) {
      entered();
      await hold;
    }
    return {
      root: 'unused',
      status: { ready: false, message: 'Synthetic runtime hold released.' },
      release: async () => {
        released++;
      },
    };
  },
};
const compiler = new Compiler(runtime, path.join(root, 'builds'));
const project = (revision) => ({
  id: 'synthetic-backlog',
  name: 'Synthetic backlog',
  mainFile: 'main.tex',
  revision,
  files: [{ path: 'main.tex', content: 'Synthetic bounded-queue fixture.' }],
});
const pending = [
  compiler.compile(project(0)).then((r) => {
    settled++;
    return r;
  }),
];
await entry;
const before = process.memoryUsage();
const start = performance.now();
for (let i = 1; i <= 5000; i++)
  pending.push(
    compiler.compile(project(i)).then((r) => {
      settled++;
      return r;
    }),
  );
await new Promise((r) => setImmediate(r));
await new Promise((r) => setImmediate(r));
const report = {
  sourceSha256: createHash('sha256')
    .update(await fs.readFile('electron/core/compiler.ts'))
    .digest('hex'),
  requests: pending.length,
  settledWhileFirstRuntimeAcquisitionHeld: settled,
  unsettledWhileHeld: pending.length - settled,
  enqueueAndObservationMs: performance.now() - start,
  hostHeapBefore: before.heapUsed,
  hostHeapAfter: process.memoryUsage().heapUsed,
  scope:
    'Controlled runtime acquisition; no native compiler or AI call. Heap readings are not a whole-app memory measurement.',
};
release();
const results = await Promise.all(pending);
report.acquired = acquired;
report.released = released;
report.cancelled = results.filter((r) => r.status === 'cancelled').length;
report.finalResult = results.at(-1);
report.busyAfterSettling = compiler.busy;
await fs.writeFile(path.join(root, 'result.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ root, ...report }, null, 2));
