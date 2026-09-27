import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { signMacRuntime } from '../../scripts/sign-mac-runtime';
import { checkSignedRuntime } from '../../scripts/check-signed-runtime';
import { verifyRuntime } from '../../electron/core/runtime';

test(
  'signed Biber builds a real offline PDF without extracting or changing verified resources',
  { skip: process.platform !== 'darwin' || process.arch !== 'arm64' },
  async (t) => {
    const source = path.resolve('resources/runtime/mac-arm64');
    const original = await verifyRuntime(source);
    const work = await fs.mkdtemp(path.join(os.tmpdir(), 'folio-signed-runtime-'));
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
    await verifyRuntime(runtime, signed.after);
    assert.deepEqual((await verifyRuntime(source)).pin, original.pin);
  },
);
