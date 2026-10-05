import { spawn } from 'node:child_process';
import type { Duplex } from 'node:stream';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import type { BuildResult, Project } from '../../src/shared/types';
import { fingerprint, safeRelative } from './project';
import { compilerExecutable, inspectRuntime, macSandboxProfile } from './runtime';
import { parseDiagnostics } from './diagnostics';
import { buildFingerprint } from './build-provenance';
import { compilerLimits, limitedCompilerLaunch } from './compiler-limits';
import { BuildWorkspaces } from './build-workspaces';
import { LatestWorkQueue } from './latest-work-queue';
import { acquireEngineCache, engineCachePolicy } from './engine-cache';
import type { RuntimeLease, RuntimeSource } from './runtime-manager';

export class Compiler {
  get busy() {
    return this.queue.busy;
  }
  private readonly workspaces: BuildWorkspaces;
  private generation = 0;
  private abort: AbortController | undefined;
  private readonly queue = new LatestWorkQueue<BuildResult>();
  private last: { projectId: string; fingerprint: string; result: BuildResult } | undefined;

  constructor(
    readonly runtimeRoot: string | RuntimeSource,
    readonly workRoot: string,
    readonly timeoutMs = 30_000,
  ) {
    this.workspaces = new BuildWorkspaces(workRoot);
  }

  async cancel() {
    this.generation++;
    this.abort?.abort();
    this.queue.cancelPending();
    await this.queue.running;
  }

  currentPdf(project: Project): Uint8Array | undefined {
    return this.last?.projectId === project.id &&
      this.last.result.revision === project.revision &&
      this.last.fingerprint === fingerprint(project)
      ? this.last.result.pdf
      : undefined;
  }

  compile(project: Project, assets = new Map<string, Buffer>()): Promise<BuildResult> {
    const generation = ++this.generation;
    this.abort?.abort();
    const cancelled = (): BuildResult => ({
      projectId: project.id,
      revision: project.revision,
      status: 'cancelled',
      durationMs: 0,
      diagnostics: [],
      log: '',
    });
    const operation = async () => {
      if (generation !== this.generation) return cancelled();
      const controller = new AbortController();
      this.abort = controller;
      const start = performance.now();
      let job: string | undefined;
      let workspace: Awaited<ReturnType<BuildWorkspaces['create']>> | undefined;
      let lease: RuntimeLease | undefined;
      let cacheLease: Awaited<ReturnType<typeof acquireEngineCache>> | undefined;
      let runtimeReady = false;
      try {
        lease =
          typeof this.runtimeRoot === 'string'
            ? undefined
            : await this.runtimeRoot.acquire(project.runtime);
        const runtimeRoot = lease?.root ?? (this.runtimeRoot as string);
        const runtime = lease?.status ?? (await inspectRuntime(runtimeRoot, project.runtime));
        if (!runtime.ready) throw new Error(runtime.message);
        runtimeReady = true;
        if (generation !== this.generation) return cancelled();
        workspace = await this.workspaces.create();
        job = workspace.path;
        const source = path.join(job, 'source');
        const output = path.join(job, 'output');
        cacheLease = await acquireEngineCache(this.workRoot, runtime.pin!.id!);
        const cache = cacheLease.path;
        await Promise.all(
          [source, output, path.join(job, 'home')].map((p) => fs.mkdir(p, { recursive: true })),
        );
        for (const [name, data] of [
          ...assets,
          ...project.files.map((f) => [f.path, Buffer.from(f.content)] as const),
        ]) {
          const destination = path.join(source, safeRelative(name));
          await fs.mkdir(path.dirname(destination), { recursive: true });
          await fs.writeFile(destination, data);
        }
        const runtimePath = await fs.realpath(runtimeRoot);
        const biberCache = path.join(job, 'biber-cache');
        const bundledBiberCache = path.join(runtimePath, 'biber-cache');
        try {
          const entries = await fs.readdir(bundledBiberCache);
          await fs.mkdir(biberCache);
          // PAR locks its cache on every invocation. Keep only the lock writable;
          // dependencies remain in the read-only runtime, behind these links.
          for (const name of entries) {
            if (name !== 'inc.lock')
              await fs.symlink(path.join(bundledBiberCache, name), path.join(biberCache, name));
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        const binary = path.join(runtimePath, compilerExecutable());
        const compileArgs = [
          '-X',
          'compile',
          project.mainFile,
          '--bundle',
          path.join(runtimePath, 'bundle.zip'),
          '--only-cached',
          '--untrusted',
          '--keep-logs',
          '--outdir',
          output,
        ];
        let command = binary,
          args = compileArgs;
        if (process.platform === 'darwin') {
          const profile = path.join(job, 'compiler.sb');
          await fs.writeFile(
            profile,
            macSandboxProfile(binary, runtimePath, job, await fs.realpath(cache)),
          );
          command = '/usr/bin/sandbox-exec';
          args = ['-f', profile, binary, ...compileArgs];
        }
        // Windows and Linux runtimes carry no pre-expanded Biber archive. PAR
        // expands it once per compiler identity into this persistent folder.
        const parCache =
          process.platform === 'darwin'
            ? path.join(job, 'biber-cache')
            : path.join(this.workRoot, 'biber-par', runtime.pin!.id!);
        if (process.platform !== 'darwin') await fs.mkdir(parCache, { recursive: true });
        const execution = await this.run(
          command,
          args,
          source,
          job,
          cache,
          controller.signal,
          runtimePath,
          () => cacheLease!.check(),
          parCache,
        );
        await cacheLease.check();
        await cacheLease.release();
        cacheLease = undefined;
        if (generation !== this.generation) return cancelled();
        const diagnostics = parseDiagnostics(execution.log);
        const result: BuildResult = {
          projectId: project.id,
          revision: project.revision,
          status: execution.code === 0 ? 'success' : 'error',
          durationMs: Math.round(performance.now() - start),
          diagnostics,
          log: execution.log,
        };
        if (execution.code === 0) {
          const pdfPath = path.join(output, path.basename(project.mainFile, '.tex') + '.pdf');
          const stat = await fs.stat(pdfPath);
          if (stat.size > 25 * 1024 * 1024)
            throw new Error('The PDF exceeds the 25 MB preview limit.');
          const pdf = await fs.readFile(pdfPath);
          if (!pdf.subarray(0, 5).equals(Buffer.from('%PDF-')))
            throw new Error('The compiler did not produce a valid PDF.');
          if (generation !== this.generation) return cancelled();
          result.pdf = new Uint8Array(pdf);
          result.buildFingerprint = buildFingerprint(project, assets, runtime.pin);
          this.last = { projectId: project.id, fingerprint: fingerprint(project), result };
        } else if (!diagnostics.some((d) => d.severity === 'error'))
          diagnostics.push({
            severity: 'error',
            message:
              execution.log.trim().split('\n').slice(-3).join(' ') ||
              'Compilation failed. Open the build log for details.',
          });
        return result;
      } catch (error) {
        if (generation !== this.generation) return cancelled();
        return {
          projectId: project.id,
          revision: project.revision,
          status: 'error' as const,
          durationMs: Math.round(performance.now() - start),
          diagnostics: [{ severity: 'error' as const, message: (error as Error).message }],
          log: (error as Error).message,
          runtimeUnavailable: !runtimeReady,
        };
      } finally {
        await cacheLease?.release().catch(() => {});
        await workspace?.release().catch(() => {});
        await lease?.release();
        if (generation === this.generation) this.abort = undefined;
      }
    };
    return this.queue.enqueue(async () => {
      const result = await operation();
      return generation === this.generation ? result : cancelled();
    }, cancelled);
  }

  private run(
    command: string,
    args: string[],
    cwd: string,
    home: string,
    cache: string,
    signal: AbortSignal,
    runtimePath: string,
    checkCache?: () => Promise<void>,
    parCache = path.join(home, 'biber-cache'),
  ): Promise<{
    code: number;
    log: string;
  }> {
    return new Promise((resolve, reject) => {
      const windows = process.platform === 'win32';
      const launch = limitedCompilerLaunch(command, args, this.timeoutMs, !windows);
      const child = spawn(launch.command, launch.args, {
        cwd,
        detached: launch.posixGroup,
        windowsHide: true,
        stdio: windows ? ['ignore', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe', 'pipe'],
        env: compilerEnvironment(runtimePath, home, cache, parCache),
      });
      const parentWatch = windows ? undefined : (child.stdio[3] as Duplex);
      let log = '';
      let failure: string | undefined;
      const stop = () => {
        if (!child.pid) return;
        if (windows) {
          // Tectonic starts Biber as a child; end the whole tree.
          spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
            windowsHide: true,
            stdio: 'ignore',
          }).once('error', () => child.kill());
          return;
        }
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          child.kill('SIGKILL');
        }
      };
      parentWatch?.once('error', () => {
        failure = 'The compiler parent connection failed.';
        stop();
      });
      const cancel = () => {
        failure = 'Compilation cancelled.';
        stop();
      };
      const timer = setTimeout(() => {
        failure = `Compilation exceeded the ${Math.ceil(this.timeoutMs / 1000)}-second time limit. Simplify the document and try again.`;
        stop();
      }, this.timeoutMs);
      const append = (chunk: Buffer) => {
        log += chunk.toString();
        if (log.length > 1024 * 1024) {
          failure = 'The compiler produced too much output. Check for recursive commands.';
          log = log.slice(0, 1024 * 1024);
          stop();
        }
      };
      child.stdout!.on('data', append);
      child.stderr!.on('data', append);
      signal.addEventListener('abort', cancel, { once: true });
      if (signal.aborted) cancel();
      let cacheCheck: Promise<void> | undefined;
      let nativeClosed = false;
      const cacheTimer = checkCache
        ? setInterval(() => {
            if (cacheCheck) return;
            cacheCheck = checkCache()
              .catch((error) => {
                failure = (error as Error).message;
                if (!nativeClosed) stop();
              })
              .finally(() => {
                cacheCheck = undefined;
              });
          }, engineCachePolicy.pollMs)
        : undefined;
      const cleanup = () => {
        clearTimeout(timer);
        clearInterval(cacheTimer);
        signal.removeEventListener('abort', cancel);
      };
      child.once('error', (error) => {
        nativeClosed = true;
        parentWatch?.destroy();
        cleanup();
        reject(error);
      });
      // Close on exit, not close: descendants may still hold the log pipes.
      // The watcher kills remaining helpers on successful exits too. A dead
      // application closes this connection automatically in the kernel.
      child.once('exit', (code, exitSignal) => {
        parentWatch?.destroy();
        if (exitSignal || code !== 0) stop();
      });
      child.once('close', async (code, exitSignal) => {
        nativeClosed = true;
        cleanup();
        await cacheCheck;
        if (!failure && exitSignal) {
          if (exitSignal === 'SIGXCPU')
            failure = `Compilation reached the ${Math.ceil(this.timeoutMs / 1000)}-second CPU-time limit. Simplify the document and try again.`;
          else if (exitSignal === 'SIGXFSZ')
            failure = `The compiler tried to create a file larger than ${compilerLimits.fileBytes / 1024 / 1024} MiB. Reduce the document or its images and try again.`;
          else failure = `The LaTeX compiler stopped unexpectedly (${exitSignal}).`;
        }
        resolve({
          code: failure ? 1 : (code ?? 1),
          log: failure ? `${log}\nerror: ${failure}` : log,
        });
      });
    });
  }
}

export function compilerEnvironment(
  runtimePath: string,
  home: string,
  cache: string,
  parCache: string,
  platform: NodeJS.Platform = process.platform,
  host: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const shared = {
    PAR_GLOBAL_TEMP: parCache,
    TECTONIC_CACHE_DIR: cache,
    TECTONIC_UNTRUSTED_MODE: '1',
    XDG_CONFIG_HOME: path.join(home, 'home'),
    LANG: 'en_US.UTF-8',
  };
  if (platform !== 'win32')
    return {
      ...shared,
      PATH: `${runtimePath}${path.delimiter}/usr/bin${path.delimiter}/bin`,
      HOME: path.join(home, 'home'),
      TMPDIR: home,
    };
  // Windows programs need SystemRoot to load system libraries.
  const systemRoot = host.SystemRoot ?? host.SYSTEMROOT ?? 'C:\\Windows';
  return {
    ...shared,
    PATH: [runtimePath, path.win32.join(systemRoot, 'System32'), systemRoot].join(';'),
    SystemRoot: systemRoot,
    windir: systemRoot,
    TEMP: home,
    TMP: home,
    USERPROFILE: path.win32.join(home, 'home'),
    APPDATA: path.win32.join(home, 'home'),
    LOCALAPPDATA: path.win32.join(home, 'home'),
  };
}
