import type { Project } from './types';

/** Automatic snapshots retain one active native write and the newest pending project. */
export class RecoveryWrites {
  private pending: Project | undefined;
  private active: Promise<void> | undefined;
  error = '';

  constructor(
    private readonly write: (project: Project) => Promise<void>,
    private readonly changed: (error: string) => void = () => {},
  ) {}

  set(project: Project) {
    this.pending = project;
    if (!this.error) void this.start();
  }

  // Switching the visible project must not leave an older waiting snapshot behind.
  // Bootstrap alone must not create a write before recovery has been reviewed.
  replacePending(project: Project) {
    if (this.pending) this.pending = project;
  }

  private start(): Promise<void> {
    if (this.active) return this.active;
    const active = Promise.resolve()
      .then(() => this.drain())
      .finally(() => {
        if (this.active === active) this.active = undefined;
        // A new snapshot can arrive after drain observed an empty queue but
        // before this completion microtask. It still needs a writer.
        if (this.pending && !this.error) void this.start();
      });
    this.active = active;
    return active;
  }

  private async drain() {
    while (this.pending) {
      const project = this.pending;
      this.pending = undefined;
      try {
        await this.write(project);
      } catch (error) {
        this.pending ??= project;
        this.error = error instanceof Error ? error.message : String(error);
        this.changed(this.error);
        return;
      }
    }
    this.error = '';
    this.changed('');
  }

  async flush(project?: Project) {
    if (project) this.pending = project;
    if (this.active) await this.active;
    this.error = '';
    while (this.pending || this.active) {
      await this.start();
      if (this.error) throw new Error(this.error);
    }
  }
}
