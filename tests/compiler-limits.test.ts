import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { performance } from 'node:perf_hooks';
import { Compiler } from '../electron/core/compiler';
import { compilerLimits, limitedCompilerLaunch } from '../electron/core/compiler-limits';

const native = { skip: process.platform !== 'darwin', timeout: 20_000 };
const cleanEnv = { PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8' };
async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'folio-compiler-limits-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const run = (command: string, args: string[], timeoutMs = 5000) => {
    const compiler = new Compiler(root, root, timeoutMs);
    return compiler['run'](
      command,
      args,
      root,
      root,
      root,
      new AbortController().signal,
      path.dirname(process.execPath),
    );
  };
  return { root, run };
}

test('compiler children inherit both limit values and cannot raise the hard limits', native, () => {
  const program =
    'for kind in t f n c; do ulimit -S -$kind; ulimit -H -$kind; done; if ulimit -H -n 257 2>/dev/null; then exit 90; fi';
  const launch = limitedCompilerLaunch('/bin/bash', ['--noprofile', '--norc', '-c', program], 2000);
  const text = execFileSync(launch.command, launch.args, { env: cleanEnv, encoding: 'utf8' });
  assert.deepEqual(text.trim().split('\n').map(Number), [
    2,
    2,
    compilerLimits.fileBytes / 1024,
    compilerLimits.fileBytes / 1024,
    compilerLimits.openFiles,
    compilerLimits.openFiles,
    0,
    0,
  ]);
});

test(
  'resource launcher preserves arguments as literal data including shell metacharacters',
  native,
  async (t) => {
    const { root } = await fixture(t);
    const sentinel = path.join(root, 'must-not-exist');
    const values = [
      'a path with spaces',
      "a'quote",
      '"double"',
      '`touch ' + sentinel + '`',
      '$(touch ' + sentinel + ')',
      '; touch ' + sentinel,
      'a\\b',
      'line\nbreak',
    ];
    const launch = limitedCompilerLaunch(
      process.execPath,
      ['-e', 'console.log(JSON.stringify(process.argv.slice(1)))', ...values],
      5000,
    );
    const text = execFileSync(launch.command, launch.args, { env: cleanEnv, encoding: 'utf8' });
    assert.deepEqual(JSON.parse(text), values);
    await assert.rejects(fs.access(sentinel));
  },
);

test('failure to install a limit never launches the requested program', native, async (t) => {
  const { root } = await fixture(t);
  const sentinel = path.join(root, 'must-not-launch');
  const launch = limitedCompilerLaunch(
    process.execPath,
    ['-e', 'require("node:fs").writeFileSync(process.argv[1],"wrong")', sentinel],
    5000,
  );
  let failure: { status?: number; stderr?: Buffer } | undefined;
  try {
    execFileSync(
      '/bin/bash',
      [
        '--noprofile',
        '--norc',
        '-c',
        'ulimit -S -H -n 64 || exit 99; exec "$@"',
        'stricter-parent',
        launch.command,
        ...launch.args,
      ],
      { env: cleanEnv, stdio: 'pipe' },
    );
  } catch (error) {
    failure = error as typeof failure;
  }
  assert.equal(failure?.status, 125);
  assert.match(String(failure?.stderr), /could not apply the compiler resource limits/);
  await assert.rejects(fs.access(sentinel));
});

test(
  'kernel file-size enforcement stops a production compiler-run child at the byte ceiling',
  native,
  async (t) => {
    const { root, run } = await fixture(t);
    const output = path.join(root, 'bounded-output');
    const result = await run(process.execPath, [
      '-e',
      'const fs=require("node:fs"), f=fs.openSync(process.argv[1],"w"), block=Buffer.alloc(1024*1024); for(let n=0;n<200;n++) fs.writeSync(f,block);',
      output,
    ]);
    assert.equal(result.code, 1);
    assert.match(result.log, /larger than 128 MiB|EFBIG/);
    assert.equal((await fs.stat(output)).size, compilerLimits.fileBytes);
  },
);

test(
  'kernel descriptor enforcement refuses additional files inside the production launch path',
  native,
  async (t) => {
    const { run } = await fixture(t);
    const result = await run(process.execPath, [
      '-e',
      'const fs=require("node:fs"), opened=[]; let result; try {for(let n=0;n<1000;n++) opened.push(fs.openSync("/dev/null","r"));} catch(e) {result={code:e.code,count:opened.length};} finally {opened.forEach(fd=>fs.closeSync(fd));} console.log(JSON.stringify(result));',
    ]);
    assert.equal(result.code, 0, result.log);
    const output = JSON.parse(result.log);
    assert.equal(output.code, 'EMFILE');
    assert.ok(output.count > 0 && output.count < compilerLimits.openFiles);
  },
);

test(
  'macOS delivers its CPU limit without relying on the application wall timer',
  native,
  async () => {
    const launch = limitedCompilerLaunch(process.execPath, ['-e', 'while(true){}'], 1000);
    const child = spawn(launch.command, launch.args, {
      env: cleanEnv,
      detached: true,
      stdio: 'ignore',
    });
    let guardKilled = false;
    const guard = setTimeout(() => {
      guardKilled = true;
      if (child.pid) process.kill(-child.pid, 'SIGKILL');
    }, 10_000);
    try {
      const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
        (resolve, reject) => {
          child.once('error', reject);
          child.once('close', (code, signal) => resolve({ code, signal }));
        },
      );
      assert.equal(guardKilled, false);
      assert.equal(result.signal, 'SIGXCPU');
    } finally {
      clearTimeout(guard);
    }
  },
);

test(
  'the production wall timeout stops a process even when its CPU signal is caught',
  native,
  async (t) => {
    const { run } = await fixture(t);
    const program =
      'process.on("SIGXCPU",()=>console.error("caught CPU signal")); function spin(){const end=performance.now()+10; while(performance.now()<end){}; setImmediate(spin);} spin();';
    const start = performance.now();
    const result = await run(
      '/bin/bash',
      [
        '--noprofile',
        '--norc',
        '-c',
        'ulimit -S -t 1 || exit 99; exec "$@"',
        'lower-cpu-threshold',
        process.execPath,
        '-e',
        program,
      ],
      4000,
    );
    assert.equal(result.code, 1);
    assert.match(result.log, /caught CPU signal/);
    assert.match(result.log, /Compilation exceeded the 4-second time limit/);
    assert.ok(performance.now() - start < 8000);
  },
);

test(
  'resource-signal exit terminates remaining compiler-group children before the wall deadline',
  native,
  async (t) => {
    const { root, run } = await fixture(t);
    const pidFile = path.join(root, 'helper.pid');
    const program =
      'const fs=require("node:fs"),cp=require("node:child_process"); const child=cp.spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore"}); fs.writeFileSync(process.argv[1],String(child.pid)); while(true){}';
    const start = performance.now();
    const result = await run(
      '/bin/bash',
      [
        '--noprofile',
        '--norc',
        '-c',
        'ulimit -S -t 1 || exit 99; exec "$@"',
        'lower-cpu-threshold',
        process.execPath,
        '-e',
        program,
        pidFile,
      ],
      8000,
    );
    assert.equal(result.code, 1);
    assert.match(result.log, /CPU-time limit/);
    assert.ok(performance.now() - start < 6000);
    const pid = Number(await fs.readFile(pidFile, 'utf8'));
    let alive = true;
    for (let attempt = 0; attempt < 40; attempt++) {
      try {
        const state = execFileSync('/bin/ps', ['-o', 'stat=', '-p', String(pid)], {
          encoding: 'utf8',
        }).trim();
        alive = !!state && !state.startsWith('Z');
      } catch {
        alive = false;
      }
      if (!alive) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    // Also prevent a failed regression control from leaving its synthetic helper.
    if (alive) process.kill(pid, 'SIGKILL');
    assert.equal(alive, false, 'A helper survived the compiler resource-signal exit');
  },
);
