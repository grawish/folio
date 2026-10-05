import test from 'node:test';
import assert from 'node:assert/strict';
import { adoptRuntime, type RuntimePin } from '../src/shared/runtime';
import { biberFiles, compilerExecutable, compilerIsolation } from '../electron/core/runtime';
import { limitedCompilerLaunch } from '../electron/core/compiler-limits';
import { compilerEnvironment } from '../electron/core/compiler';

const pin = (platform: string, id: string, extra: Partial<RuntimePin> = {}): RuntimePin => ({
  engine: 'tectonic',
  version: '0.17.0',
  bundle: 'folio-core-v1',
  id: id.repeat(64),
  platform,
  biberVersion: '2.17',
  ...extra,
});

test('a project pinned on another OS adopts the identical local compiler', () => {
  const mac = pin('darwin-arm64', 'a'),
    linux = pin('linux-x64', 'b');
  assert.deepEqual(adoptRuntime(mac, linux), linux);
  assert.deepEqual(adoptRuntime(linux, linux), linux);
  // A different bundle or Biber version keeps the recorded choice.
  assert.deepEqual(
    adoptRuntime(pin('darwin-arm64', 'c', { bundle: 'other' }), linux)?.bundle,
    'other',
  );
  const noBiber = pin('darwin-arm64', 'd', { biberVersion: undefined });
  assert.equal(adoptRuntime(noBiber, linux)?.id, noBiber.id);
});

test('platform runtime names and isolation labels', () => {
  assert.equal(compilerExecutable('win32-x64'), 'tectonic.exe');
  assert.equal(compilerExecutable('linux-x64'), 'tectonic');
  assert.deepEqual(biberFiles('darwin-arm64'), ['biber', 'biber-cache/biber']);
  assert.deepEqual(biberFiles('linux-x64'), ['biber']);
  assert.deepEqual(biberFiles('win32-x64'), ['biber.exe']);
  assert.equal(compilerIsolation('darwin'), 'macos-seatbelt');
  assert.equal(compilerIsolation('linux'), 'posix-limits');
  assert.equal(compilerIsolation('win32'), 'untrusted-mode');
  assert.equal(compilerIsolation('freebsd'), 'unavailable');
});

test('Windows launches the compiler directly; POSIX wraps it in resource limits', () => {
  const win = limitedCompilerLaunch(
    'C:\\Folio\\tectonic.exe',
    ['-X', 'compile'],
    30_000,
    false,
    'win32',
  );
  assert.deepEqual(win, {
    command: 'C:\\Folio\\tectonic.exe',
    args: ['-X', 'compile'],
    posixGroup: false,
  });
  const linux = limitedCompilerLaunch('/r/tectonic', ['-X'], 30_000, true, 'linux');
  assert.equal(linux.command, '/bin/bash');
  assert.equal(linux.posixGroup, true);
  assert.deepEqual(linux.args.slice(-2), ['/r/tectonic', '-X']);
  assert.throws(() => limitedCompilerLaunch('x', [], 0, false, 'win32'), /time limit/);
});

test('Windows compiler environment keeps system libraries reachable and nothing else', () => {
  const env = compilerEnvironment('C:\\rt', 'C:\\job', 'C:\\cache', 'C:\\par', 'win32', {
    SystemRoot: 'D:\\Win',
    SECRET_TOKEN: 'x',
  });
  assert.equal(env.PATH, 'C:\\rt;D:\\Win\\System32;D:\\Win');
  assert.equal(env.SystemRoot, 'D:\\Win');
  assert.equal(env.TEMP, 'C:\\job');
  assert.equal(env.PAR_GLOBAL_TEMP, 'C:\\par');
  assert.equal(env.TECTONIC_UNTRUSTED_MODE, '1');
  assert.equal(env.SECRET_TOKEN, undefined);
  const posix = compilerEnvironment('/rt', '/job', '/cache', '/par', 'linux', {
    SECRET_TOKEN: 'x',
  });
  assert.equal(posix.HOME, '/job/home');
  assert.equal(posix.SECRET_TOKEN, undefined);
});
