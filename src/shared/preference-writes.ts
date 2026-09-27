import { validatePreferencePatch, type PreferencePatch } from './preferences';

// One active write and at most one latest value per setting, even during a
// long pane drag or a slow filesystem. A failed write retains the newest edits.
export class PreferenceWrites {
  private pending: PreferencePatch = {};
  private active: Promise<void> | undefined;
  error = '';
  constructor(
    private readonly write: (patch: PreferencePatch) => Promise<void>,
    private readonly changed: () => void = () => {},
  ) {}
  set(patch: PreferencePatch) {
    Object.assign(this.pending, validatePreferencePatch(patch));
    if (!this.error) void this.start();
  }
  private start(): Promise<void> {
    if (this.active) return this.active;
    this.active = this.drain().finally(() => {
      this.active = undefined;
    });
    return this.active;
  }
  private async drain() {
    while (Object.keys(this.pending).length) {
      const patch = this.pending;
      this.pending = {};
      try {
        await this.write(patch);
      } catch (error) {
        this.pending = { ...patch, ...this.pending };
        this.error = error instanceof Error ? error.message : String(error);
        this.changed();
        return;
      }
    }
    this.error = '';
    this.changed();
  }
  async flush() {
    if (this.active) await this.active;
    this.error = '';
    if (Object.keys(this.pending).length) await this.start();
    if (this.error) throw new Error(this.error);
  }
}
