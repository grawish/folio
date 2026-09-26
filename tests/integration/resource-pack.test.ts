import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { RuntimeManager } from '../../electron/core/runtime-manager';
import { Compiler } from '../../electron/core/compiler';
import {
  buildResourcePack,
  ResourcePackVerifier,
  ResourcePackStore,
} from '../../electron/core/resource-pack';

test(
  'signed resources compile offline only with their exact installed pack; failed pack checks preserve working compilers',
  {
    skip: process.platform !== 'darwin' || process.arch !== 'arm64',
    timeout: 300_000,
  },
  async (t) => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'folio-native-pack-')));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const baseRoot = path.resolve('resources/runtime/mac-arm64');
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const verifier = new ResourcePackVerifier({
      fixture: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    });
    const packs = new ResourcePackStore(path.join(root, 'archives'), verifier);
    const probe = String.raw`\documentclass{article}\usepackage{folio-pack-check}\begin{document}\FolioPackCheck\end{document}`;
    const recipe = {
      baseRoot,
      id: 'folio-native-check-v1',
      title: 'Offline check',
      description: 'Original test-only resource.',
      bundle: 'folio-native-check-v1',
      packages: ['folio-pack-check.sty'],
      resources: new Map([
        [
          'folio-pack-check.sty',
          Buffer.from(
            String.raw`\ProvidesPackage{folio-pack-check}[2026/09/26 Folio test]\newcommand{\FolioPackCheck}{Folio signed pack compiled offline.}\endinput`,
          ),
        ],
      ]),
      notices:
        'Original Folio test fixture, distributed under the repository PolyForm Noncommercial license. No third-party resources are added.',
      probe,
      keyId: 'fixture',
      privateKey,
    };
    const started = performance.now();
    const built = await buildResourcePack(recipe);
    const pack = await packs.retain(built.archive);
    const manager = new RuntimeManager(baseRoot, path.join(root, 'managed'), { packs });
    await manager.initialize();
    assert.equal((await manager.status()).ready, true);
    assert.deepEqual(manager.defaultPin, pack.base);
    const compiler = new Compiler(manager, path.join(root, 'builds'));
    t.after(() => compiler.cancel());
    const project = {
      id: 'native-pack-check',
      name: 'Pack check',
      mainFile: 'main.tex',
      revision: 0,
      runtime: pack.base,
      files: [{ path: 'main.tex', content: probe }],
    };
    const missing = await compiler.compile(project);
    assert.equal(missing.status, 'error', missing.log);
    assert.match(missing.log, /folio-pack-check/);
    const installed = await manager.installPack(pack);
    assert.equal(installed.ready, true, installed.message);
    assert.deepEqual(project.runtime, pack.base);
    assert.deepEqual(manager.defaultPin, pack.base);
    const result = await compiler.compile({ ...project, revision: 1, runtime: pack.target });
    assert.equal(result.status, 'success', result.log);
    assert.ok(result.pdf && result.pdf.length > 1000);
    const stillMissing = await compiler.compile({ ...project, revision: 2 });
    assert.equal(stillMissing.status, 'error');
    const ordinary = await compiler.compile({
      ...project,
      revision: 3,
      files: [
        {
          path: 'main.tex',
          content: String.raw`\documentclass{article}\begin{document}Base still works offline.\end{document}`,
        },
      ],
    });
    assert.equal(ordinary.status, 'success', ordinary.log);
    // A valid signature does not excuse a broken compatibility test.
    const broken = await buildResourcePack({
      ...recipe,
      id: 'folio-broken-check-v1',
      bundle: 'folio-broken-check-v1',
      probe: String.raw`\documentclass{article}\begin{document}\FolioUndefinedCommand\end{document}`,
    });
    await assert.rejects(
      manager.installPack(verifier.read(broken.archive)),
      /resource pack check failed/,
    );
    assert.equal((await manager.status(pack.target)).ready, true);
    assert.equal((await manager.status(broken.target)).ready, false);
    const restored = await compiler.compile({ ...project, revision: 4, runtime: pack.target });
    assert.equal(restored.status, 'success', restored.log);
    t.diagnostic(
      `Actual sandboxed base/Biber/pack checks and offline builds completed in ${Math.round(performance.now() - started)} ms. Synthetic signing keys; not a public pack or native Settings acceptance.`,
    );
  },
);
