import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import type { BuildResult, Project } from '../../src/shared/types';
import { fingerprint, safeRelative } from './project';
import { inspectRuntime, macSandboxProfile } from './runtime';
import { parseDiagnostics } from './diagnostics';
import type { RuntimeLease, RuntimeSource } from './runtime-manager';

export class Compiler {
  private generation = 0;
  private abort: AbortController | undefined;
  private running: Promise<BuildResult> | undefined;
  private last: { projectId: string; fingerprint: string; result: BuildResult } | undefined;

  constructor(
    readonly runtimeRoot: string | RuntimeSource,
    readonly workRoot: string,
    readonly timeoutMs = 30_000,
  ) {}

  async cancel() {
    this.generation++;
    this.abort?.abort();
    await this.running;
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
    const previous = this.running;
    const cancelled = (): BuildResult => ({
      projectId: project.id,
      revision: project.revision,
      status: 'cancelled',
      durationMs: 0,
      diagnostics: [],
      log: '',
    });
    const operation = async () => {
      await previous;
      if (generation !== this.generation) return cancelled();
      const controller = new AbortController();
      this.abort = controller;
      const start = performance.now();
      let job: string | undefined;
      let lease: RuntimeLease | undefined;
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
        await fs.mkdir(this.workRoot, { recursive: true });
        job = await fs.mkdtemp(path.join(this.workRoot, 'build-'));
        job = await fs.realpath(job);
        const source = path.join(job, 'source');
        const output = path.join(job, 'output');
        const cache = path.join(this.workRoot, 'engine-cache', runtime.pin!.id!);
        await Promise.all(
          [source, output, cache, path.join(job, 'home')].map((p) =>
            fs.mkdir(p, { recursive: true }),
          ),
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
        const binary = path.join(runtimePath, 'tectonic');
        const profile = path.join(job, 'compiler.sb');
        await fs.writeFile(
          profile,
          macSandboxProfile(binary, runtimePath, job, await fs.realpath(cache)),
        );
        const args = [
          '-f',
          profile,
          binary,
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
        const execution = await this.run(
          '/usr/bin/sandbox-exec',
          args,
          source,
          job,
          cache,
          controller.signal,
          runtimePath,
        );
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
          result.pdf = new Uint8Array(pdf);
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
        if (job) await fs.rm(job, { recursive: true, force: true }).catch(() => {});
        await lease?.release();
        if (generation === this.generation) this.abort = undefined;
      }
    };
    this.running = operation();
    return this.running;
  }

  private run(
    command: string,
    args: string[],
    cwd: string,
    home: string,
    cache: string,
    signal: AbortSignal,
    runtimePath: string,
  ): Promise<{
    code: number;
    log: string;
  }> {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        cwd,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          PATH: `${runtimePath}${path.delimiter}/usr/bin${path.delimiter}/bin`,
          PAR_GLOBAL_TEMP: path.join(home, 'biber-cache'),
          HOME: path.join(home, 'home'),
          TMPDIR: home,
          TECTONIC_CACHE_DIR: cache,
          TECTONIC_UNTRUSTED_MODE: '1',
          XDG_CONFIG_HOME: path.join(home, 'home'),
          LANG: 'en_US.UTF-8',
        },
      });
      let log = '';
      let failure: string | undefined;
      const stop = () => {
        if (child.pid) {
          try {
            process.kill(-child.pid, 'SIGKILL');
          } catch {
            child.kill('SIGKILL');
          }
        }
      };
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
      child.stdout.on('data', append);
      child.stderr.on('data', append);
      signal.addEventListener('abort', cancel, { once: true });
      if (signal.aborted) cancel();
      const cleanup = () => {
        clearTimeout(timer);
        signal.removeEventListener('abort', cancel);
      };
      child.once('error', (error) => {
        cleanup();
        reject(error);
      });
      child.once('close', (code, exitSignal) => {
        cleanup();
        if (!failure && exitSignal)
          failure = `The LaTeX compiler stopped unexpectedly (${exitSignal}).`;
        resolve({
          code: failure ? 1 : (code ?? 1),
          log: failure ? `${log}\nerror: ${failure}` : log,
        });
      });
    });
  }
}
