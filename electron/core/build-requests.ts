import type { BuildResult, Project } from '../../src/shared/types';
import { LatestWorkQueue } from './latest-work-queue';

type BuildServices = {
  review(project: Project): Promise<void>;
  assets(project: Project): Promise<Map<string, Buffer>>;
  compile(project: Project, assets: Map<string, Buffer>): Promise<BuildResult>;
  cancelCompiler(): Promise<void>;
  checkpoint(project: Project, result: BuildResult): Promise<string>;
};

/** Bounds the entire editor build, including disk reads and history writes. */
export class BuildRequests {
  private readonly queue = new LatestWorkQueue<BuildResult>();
  private generation = 0;
  private stopping: Promise<void> | undefined;

  constructor(private readonly services: BuildServices) {}

  get busy() {
    return this.queue.busy;
  }

  compile(project: Project): Promise<BuildResult> {
    const generation = ++this.generation;
    const current = () => generation === this.generation;
    const cancelled = (): BuildResult => ({
      projectId: project.id,
      revision: project.revision,
      status: 'cancelled',
      durationMs: 0,
      diagnostics: [],
      log: '',
    });
    // Interrupt native work immediately, even while its replacement is waiting.
    if (this.queue.busy) this.stopCompiler();
    return this.queue.enqueue(async () => {
      if (this.stopping) await this.stopping.catch(() => {});
      if (!current()) return cancelled();
      try {
        await this.services.review(project);
        if (!current()) return cancelled();
        const assets = await this.services.assets(project);
        if (!current()) return cancelled();
        const result = await this.services.compile(project, assets);
        if (!current()) return cancelled();
        if (result.status === 'success' && result.pdf) {
          const versionId = await this.services.checkpoint(project, result);
          if (!current()) return cancelled();
          result.versionId = versionId;
        }
        return result;
      } catch (error) {
        if (!current()) return cancelled();
        throw error;
      }
    }, cancelled);
  }

  async cancel() {
    this.generation++;
    this.queue.cancelPending();
    // Wait for disk/history work too. One failure must not skip the other cleanup.
    const results = await Promise.allSettled([this.queue.running, this.stopCompiler()]);
    for (const result of results) if (result.status === 'rejected') throw result.reason;
  }

  private stopCompiler() {
    if (!this.stopping) {
      const stopping = this.services.cancelCompiler();
      this.stopping = stopping;
      const finished = () => {
        if (this.stopping === stopping) this.stopping = undefined;
      };
      // Compiler cleanup failures belong to the active request (and explicit
      // cancel). Repeated edits share this promise instead of adding waiters.
      void stopping.then(finished, finished);
    }
    return this.stopping;
  }
}
