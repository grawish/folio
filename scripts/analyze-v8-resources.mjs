import { promises as fs } from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { SourceMap } from 'node:module';
import { createHash } from 'node:crypto';
import { extractFile, listPackage } from '@electron/asar';
import { build } from 'vite';

const [resultArg, appArg] = process.argv.slice(2);
if (!resultArg || !appArg?.endsWith('.app') || process.argv.length !== 4)
  throw new Error('Provide a completed V8 diagnostic directory and its exact Folio.app.');
const root = path.resolve(resultArg);
const raw = await fs.readFile(path.join(root, 'measurements.json'));
const report = JSON.parse(raw);
assert.equal(report.passed, true);
assert.deepEqual(report.errors, []);
const asar = path.resolve(appArg, 'Contents/Resources/app.asar');
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
assert.equal(hash(await fs.readFile(asar)), report.appAsarSha256);
const members = new Set(listPackage(asar).map((x) => x.replace(/^\//, '')));
const maps = new Map();
const mapEvidence = [];
const sourceEvidence = new Map();
async function register(member, bytes, kind) {
  const payload = JSON.parse(bytes.toString());
  assert.ok(!payload.sourceRoot, 'Review nonempty map sourceRoot before using this mapping.');
  for (let i = 0; i < payload.sources.length; i++) {
    const source = path.posix.normalize(
      path.posix.join(path.posix.dirname(member), payload.sources[i]),
    );
    if (!source.startsWith('electron/') && !source.startsWith('src/')) continue;
    const actual = await fs.readFile(source, 'utf8');
    assert.equal(payload.sourcesContent[i], actual, `Packaged source map differs from ${source}`);
    sourceEvidence.set(source, hash(Buffer.from(actual)));
  }
  maps.set(member, new SourceMap(payload));
  mapEvidence.push({ member, kind, bytes: bytes.length, sha256: hash(bytes) });
}
await register(
  'dist-electron/main.cjs',
  extractFile(asar, 'dist-electron/main.cjs.map'),
  'packaged',
);
// The production renderer omits source maps. Build only into memory, then require
// exact JavaScript bytes before using the corresponding hidden diagnostic map.
const replay = await build({ logLevel: 'error', build: { write: false, sourcemap: 'hidden' } });
let rendererMaps = 0;
for (const output of (Array.isArray(replay) ? replay : [replay]).flatMap((x) => x.output)) {
  if (output.type !== 'chunk' || !output.map) continue;
  const member = `dist/${output.fileName}`;
  assert.ok(members.has(member), `No exact packaged renderer member: ${member}`);
  assert.deepEqual(
    Buffer.from(output.code),
    extractFile(asar, member),
    `Renderer replay differs: ${member}`,
  );
  const bytes = Buffer.from(output.map.toString());
  await register(member, bytes, 'byte-identical in-memory replay');
  await fs.writeFile(path.join(root, `${path.basename(member)}.diagnostic.map`), bytes);
  rendererMaps++;
}
assert.ok(rendererMaps > 0, 'No byte-identical renderer source map was reproduced.');
const cache = new Map();
function mapped(frame) {
  const key = JSON.stringify(frame);
  if (cache.has(key)) return cache.get(key);
  let member;
  if (frame.url?.includes('/app.asar/')) member = frame.url.split('/app.asar/')[1];
  else if (frame.url?.startsWith('folio://app/'))
    member = `dist/${frame.url.slice('folio://app/'.length)}`;
  const map = maps.get(member);
  const value =
    map && frame.lineNumber >= 0 && frame.columnNumber >= 0
      ? map.findEntry(frame.lineNumber, frame.columnNumber)
      : {};
  const result = value.originalSource
    ? {
        source: path.posix.normalize(
          path.posix.join(path.posix.dirname(member), value.originalSource),
        ),
        line: value.originalLine + 1,
        column: value.originalColumn + 1,
      }
    : null;
  cache.set(key, result);
  return result;
}
const add = (totals, key, value) => totals.set(key, (totals.get(key) ?? 0) + value);
const sorted = (totals) =>
  [...totals]
    .map(([label, value]) => ({ label, value }))
    .sort((a, b) => b.value - a.value || a.label.localeCompare(b.label));
async function readArtifact(item) {
  const bytes = await fs.readFile(path.join(root, path.basename(item.file)));
  assert.equal(bytes.length, item.bytes);
  assert.equal(hash(bytes), item.sha256);
  return JSON.parse(bytes);
}
const cpu = { main: [], renderer: [] };
for (const cycle of report.cpuProfiles)
  for (const role of ['main', 'renderer']) {
    const profile = await readArtifact(cycle[role]);
    assert.equal(profile.samples.length, profile.timeDeltas.length);
    assert.ok(profile.endTime > profile.startTime);
    const nodes = new Map(profile.nodes.map((n) => [n.id, n]));
    assert.equal(nodes.size, profile.nodes.length);
    const parents = new Map();
    for (const node of nodes.values())
      for (const id of node.children ?? []) {
        assert.ok(nodes.has(id));
        assert.ok(!parents.has(id));
        parents.set(id, node.id);
      }
    const self = new Map(),
      context = new Map();
    let total = 0,
      idle = 0,
      gc = 0;
    for (let i = 0; i < profile.samples.length; i++) {
      const node = nodes.get(profile.samples[i]);
      assert.ok(node);
      const micros = profile.timeDeltas[i];
      assert.ok(Number.isFinite(micros) && micros >= 0);
      total += micros;
      const frame = node.callFrame;
      const place = mapped(frame);
      const selfLabel = JSON.stringify({
        function: frame.functionName,
        url: frame.url,
        line: frame.lineNumber + 1,
        column: frame.columnNumber + 1,
        mapped: place,
      });
      add(self, selfLabel, micros);
      if (frame.functionName === '(idle)') idle += micros;
      if (frame.functionName === '(garbage collector)') gc += micros;
      let nearest = null,
        current = node;
      const visited = new Set();
      while (current) {
        assert.ok(!visited.has(current.id));
        visited.add(current.id);
        nearest = mapped(current.callFrame);
        if (nearest) break;
        current = nodes.get(parents.get(current.id));
      }
      const label = nearest?.source ?? frame.url ?? '';
      add(context, label || frame.functionName || '(native/unmapped)', micros);
    }
    assert.equal(
      [...self.values()].reduce((a, b) => a + b, 0),
      total,
    );
    assert.equal(
      [...context.values()].reduce((a, b) => a + b, 0),
      total,
    );
    cpu[role].push({
      cycle: cycle.cycle,
      samples: profile.samples.length,
      nodes: nodes.size,
      profileDurationMicroseconds: profile.endTime - profile.startTime,
      totalSampleWeightMicroseconds: total,
      idleSampleWeightMicroseconds: idle,
      gcSampleWeightMicroseconds: gc,
      contextWeights: sorted(context),
      selfWeights: sorted(self).map((x) => ({ frame: JSON.parse(x.label), microseconds: x.value })),
    });
  }
const heaps = [];
for (const observation of report.heapObservations) {
  const profile = await readArtifact(observation.profile);
  const sizes = new Map(),
    contexts = new Map(),
    ids = new Set();
  let total = 0;
  const visit = (node, parentSource) => {
    assert.ok(!ids.has(node.id));
    ids.add(node.id);
    assert.ok(Number.isFinite(node.selfSize) && node.selfSize >= 0);
    const own = mapped(node.callFrame);
    const source = own?.source ?? parentSource;
    total += node.selfSize;
    add(contexts, source ?? node.callFrame.url ?? '(unmapped)', node.selfSize);
    add(
      sizes,
      JSON.stringify({
        function: node.callFrame.functionName,
        url: node.callFrame.url,
        line: node.callFrame.lineNumber + 1,
        column: node.callFrame.columnNumber + 1,
        mapped: own,
      }),
      node.selfSize,
    );
    for (const child of node.children) visit(child, source);
  };
  visit(profile.head, null);
  for (const sample of profile.samples)
    assert.ok(ids.has(sample.nodeId) && Number.isFinite(sample.size) && sample.size >= 0);
  assert.equal(
    [...contexts.values()].reduce((a, b) => a + b, 0),
    total,
  );
  heaps.push({
    label: observation.label,
    memory: observation.memory,
    dom: observation.dom,
    mainMemory: observation.mainMemory,
    nodes: ids.size,
    treeReportedEstimatedBytes: total,
    samplesReportedEstimatedBytes: profile.samples.reduce((a, s) => a + s.size, 0),
    contextEstimatedBytes: sorted(contexts),
    selfEstimatedBytes: sorted(sizes)
      .filter((x) => x.value > 0)
      .map((x) => ({ frame: JSON.parse(x.label), bytes: x.value })),
  });
}
assert.equal(hash(await fs.readFile(asar)), report.appAsarSha256);
const result = {
  schemaVersion: 1,
  reportSha256: hash(raw),
  appAsarSha256: report.appAsarSha256,
  analysisScriptSha256: hash(await fs.readFile('scripts/analyze-v8-resources.mjs')),
  sourceMaps: mapEvidence,
  ownedSources: [...sourceEvidence].map(([file, sha256]) => ({ file, sha256 })),
  cycles: report.cycles,
  cpu,
  heaps,
  scope:
    'CPU weights sum V8 time deltas, not kernel CPU time or complete native-thread work. Context attribution assigns each sample once to its nearest mapped stack ancestor; it is call-stack context, not causal blame. Heap node selfSize and individual sample estimates are reported separately because rounding can differ. Allocation samples are not the full retained heap. All mappings require exact packaged JavaScript and matching owned source contents; no app files or dist outputs are changed.',
};
await fs.writeFile(path.join(root, 'v8-analysis.json'), JSON.stringify(result, null, 2) + '\n');
for (const role of ['main', 'renderer']) {
  const totals = new Map();
  for (const c of cpu[role]) for (const x of c.contextWeights) add(totals, x.label, x.value);
  console.log(role, JSON.stringify(sorted(totals).slice(0, 12)));
}
console.log(
  'Heap observations:',
  JSON.stringify(
    heaps.map((h) => ({
      label: h.label,
      usedBytes: h.memory.usedSize,
      heapCapacityBytes: h.memory.totalSize,
      nodes: h.dom.nodes,
      documents: h.dom.documents,
      listeners: h.dom.jsEventListeners,
      sampledEstimatedBytes: h.treeReportedEstimatedBytes,
      topContexts: h.contextEstimatedBytes.slice(0, 6),
    })),
  ),
);
console.log(`Analysis: ${path.join(root, 'v8-analysis.json')}`);
