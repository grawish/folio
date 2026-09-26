import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { ResourcePackVerifier, ResourcePackStore } from '../electron/core/resource-pack';
import { RuntimeManager } from '../electron/core/runtime-manager';
import { Compiler } from '../electron/core/compiler';

const folder = path.resolve(process.argv[2] ?? 'artifacts/resource-packs-v1');
const publisher = JSON.parse(await fs.readFile('resources/pack-publisher.json', 'utf8'));
const publication = JSON.parse(await fs.readFile(path.join(folder, 'publication.json'), 'utf8'));
const root = await fs.mkdtemp(path.resolve('test-results/published-pack-'));
const verifier = new ResourcePackVerifier(publisher.keys, publisher.retiredKeys);
const packs = new ResourcePackStore(path.join(root, 'archives'), verifier);
const manager = new RuntimeManager(
  path.resolve('resources/runtime/mac-arm64'),
  path.join(root, 'runtimes'),
  { packs },
);
const compiler = new Compiler(manager, path.join(root, 'builds'));
const results = [];
try {
  for (const material of publication.materials) {
    const bytes = await fs.readFile(
      path.join(folder, path.basename(new URL(material.url).pathname)),
    );
    assert.equal(bytes.length, material.bytes);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), material.sha256);
  }
  for (const row of publication.packs) {
    const bytes = await fs.readFile(
      path.join(folder, path.basename(new URL(row.artifact.url).pathname)),
    );
    assert.equal(bytes.length, row.artifact.bytes);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), row.artifact.sha256);
    const pack = await packs.retain(bytes);
    assert.deepEqual(pack.base, row.base);
    assert.deepEqual(pack.target, row.target);
    const source = await fs.readFile('resources/packs/multirow-v1/probe.tex', 'utf8');
    const project = {
      id: 'published-table-check',
      name: 'Table resources',
      mainFile: 'main.tex',
      revision: 0,
      runtime: pack.base,
      files: [{ path: 'main.tex', content: source }],
    };
    const missing = await compiler.compile(project);
    assert.equal(missing.status, 'error');
    assert.match(missing.log, /multirow/);
    const status = await manager.installPack(pack);
    assert.equal(status.ready, true, status.message);
    assert.deepEqual(manager.defaultPin, pack.base);
    const corpus = [];
    for (const size of [10, 11, 12])
      for (const paper of ['a4paper', 'letterpaper']) {
        const name = `table-${size}-${paper}`;
        const built = await compiler.compile({
          ...project,
          id: name,
          runtime: pack.target,
          revision: 1,
          files: [
            { path: 'main.tex', content: source.replace('[11pt,a4paper]', `[${size}pt,${paper}]`) },
          ],
        });
        await fs.writeFile(path.join(root, `${name}.log`), built.log);
        assert.equal(built.status, 'success', built.log);
        assert.ok(built.pdf && built.pdf.length > 1000);
        await fs.writeFile(path.join(root, `${name}.pdf`), built.pdf);
        corpus.push({ size, paper, pdfBytes: built.pdf.length, passed: true });
      }
    assert.equal((await manager.status(pack.base)).ready, true);
    results.push({
      id: pack.id,
      artifact: row.artifact,
      base: pack.base,
      target: pack.target,
      offlineCompile: true,
      baseUnchanged: true,
      corpus,
    });
  }
  await fs.writeFile(
    path.join(root, 'result.json'),
    JSON.stringify(
      {
        passed: true,
        results,
        scope:
          'Actual publisher signature, real native core and sandboxed offline compiler; source artifact, not packaged UI acceptance.',
      },
      null,
      2,
    ) + '\n',
  );
  console.log(
    `PASS: signed public-pack candidate and source materials verified; real offline table build succeeded.\nEvidence: ${root}`,
  );
} finally {
  await compiler.cancel();
}
