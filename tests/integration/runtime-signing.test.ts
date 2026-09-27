import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { signMacRuntime } from '../../scripts/sign-mac-runtime';
import { checkSignedRuntime } from '../../scripts/check-signed-runtime';
import { verifyRuntime } from '../../electron/core/runtime';
import { RuntimeManager } from '../../electron/core/runtime-manager';
import { Compiler } from '../../electron/core/compiler';
import {
  buildResourcePack,
  ResourcePackVerifier,
  ResourcePackStore,
} from '../../electron/core/resource-pack';

test(
  'signed Biber and resource packs preserve exact native bytes through offline installation and restart',
  { skip: process.platform !== 'darwin' || process.arch !== 'arm64', timeout: 300_000 },
  async (t) => {
    const source = path.resolve('resources/runtime/mac-arm64');
    const original = await verifyRuntime(source);
    const work = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), 'folio-signed-runtime-')),
    );
    t.after(() => fs.rm(work, { recursive: true, force: true }));
    const runtime = path.join(work, 'runtime with spaces');
    await fs.cp(source, runtime, { recursive: true });
    const signed = await signMacRuntime(runtime, { identity: '-', adHocTest: true });
    assert.notEqual(signed.after.id, original.pin.id);
    assert.equal(signed.code.length, 158);
    assert.equal(signed.preparation?.perlVersion, '5.32.1');
    assert.equal(signed.preparation?.unavailableOptionalImports.length, 2);
    const marker = path.join(work, 'injected');
    await fs.writeFile(
      path.join(work, 'Injected.pm'),
      'package Injected; BEGIN { open(my $fh, ">", $ENV{FOLIO_INJECTION_MARKER}) or die $!; print $fh "loaded"; } 1;',
    );
    const result = execFileSync(path.join(runtime, 'biber'), ['--version'], {
      encoding: 'utf8',
      timeout: 60_000,
      env: {
        PATH: '/usr/bin:/bin',
        HOME: work,
        TMPDIR: work,
        PERL5OPT: '-MInjected',
        PERL5LIB: work,
        PERLLIB: work,
        PAR_APP_REUSE: marker,
        FOLIO_INJECTION_MARKER: marker,
      },
    });
    assert.equal(result.trim(), 'biber version: 2.17');
    await assert.rejects(fs.access(marker));
    const check = await checkSignedRuntime(runtime);
    assert.equal(check.passed, true);
    assert.deepEqual(check.pin, signed.after);
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const verifier = new ResourcePackVerifier({
      fixture: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    });
    const archives = path.join(work, 'archives');
    const packs = new ResourcePackStore(archives, verifier);
    const probe = String.raw`\documentclass{article}\usepackage{folio-signed-base-check}\begin{document}\FolioSignedBaseCheck\end{document}`;
    const recipe = {
      baseRoot: runtime,
      id: 'folio-signed-base-check-v1',
      title: 'Signed base check',
      description: 'Original test-only resource for the final signed compiler.',
      bundle: 'folio-signed-base-check-v1',
      packages: ['folio-signed-base-check.sty'],
      resources: new Map([
        [
          'folio-signed-base-check.sty',
          Buffer.from(
            String.raw`\ProvidesPackage{folio-signed-base-check}[2026/09/27 Folio test]\newcommand{\FolioSignedBaseCheck}{Signed base resources work offline.}\endinput`,
          ),
        ],
      ]),
      notices:
        'Original Folio test fixture under the repository PolyForm Noncommercial license. No third-party resources are added.',
      probe,
      keyId: 'fixture',
      privateKey,
    };
    const unsignedPack = verifier.read(
      (await buildResourcePack({ ...recipe, baseRoot: source })).archive,
    );
    const signedPack = await packs.retain((await buildResourcePack(recipe)).archive);
    assert.deepEqual(unsignedPack.base, original.pin);
    assert.deepEqual(signedPack.base, signed.after);
    assert.notEqual(unsignedPack.target.id, signedPack.target.id);
    const managed = path.join(work, 'managed');
    const manager = new RuntimeManager(runtime, managed, { packs });
    await assert.rejects(manager.installPack(unsignedPack), /exact base compiler first/);
    const installed = await manager.installPack(signedPack);
    assert.equal(installed.ready, true, installed.message);
    assert.deepEqual(manager.defaultPin, signed.after);
    // A fresh manager/store must discover the installed exact target from disk.
    const restarted = new RuntimeManager(runtime, managed, {
      packs: new ResourcePackStore(archives, verifier),
    });
    const lease = await restarted.acquire(signedPack.target);
    try {
      await verifyRuntime(lease.root, signedPack.target);
      for (const entry of signed.code) {
        assert.deepEqual(
          await fs.readFile(path.join(lease.root, entry.path)),
          await fs.readFile(path.join(runtime, entry.path)),
          `Resource installation changed signed native bytes: ${entry.path}`,
        );
        execFileSync(
          '/usr/bin/codesign',
          ['--verify', '--strict', '--all-architectures', path.join(lease.root, entry.path)],
          { timeout: 30_000, stdio: 'pipe' },
        );
      }
    } finally {
      await lease.release();
    }
    const compiler = new Compiler(restarted, path.join(work, 'pack-builds'), 60_000);
    try {
      const content = (
        await fs.readFile('resources/runtime-checks/resume-packages.tex', 'utf8')
      ).replace(
        '\\begin{document}',
        '\\usepackage{folio-signed-base-check}\n\\begin{document}\n\\FolioSignedBaseCheck',
      );
      const project = {
        id: 'signed-pack-restart',
        name: 'Signed pack restart',
        revision: 0,
        mainFile: 'main.tex',
        runtime: signedPack.target,
        files: [{ path: 'main.tex', content }],
      };
      const result = await compiler.compile(project);
      assert.equal(result.status, 'success', result.log);
      assert.ok(result.pdf && result.pdf.length > 1000);
      assert.match(result.log, /Running external tool biber/);
      const base = await compiler.compile({ ...project, revision: 1, runtime: signed.after });
      assert.equal(base.status, 'error', base.log);
      assert.match(base.log, /folio-signed-base-check/);
      assert.deepEqual(restarted.defaultPin, signed.after);
    } finally {
      await compiler.cancel();
    }
    await verifyRuntime(runtime, signed.after);
    assert.deepEqual((await verifyRuntime(source)).pin, original.pin);
    t.diagnostic(
      'Ad-hoc Apple signatures and an ephemeral pack key; real managed installation, restart, all 158 native signature checks and offline Biber PDF. No public pack, catalog or Settings acceptance claim.',
    );
  },
);
