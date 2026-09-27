type Work<Result> = {
  operation(): Promise<Result>;
  cancelled(): Result;
  promise: Promise<Result>;
  resolve(result: Result): void;
  reject(error: unknown): void;
};

/** Keeps active cleanup in order, plus only the newest waiting request. */
export class LatestWorkQueue<Result> {
  private active: Work<Result> | undefined;
  private pending: Work<Result> | undefined;

  get busy() {
    return !!this.active;
  }

  get running() {
    return this.active?.promise;
  }

  enqueue(operation: () => Promise<Result>, cancelled: () => Result): Promise<Result> {
    let resolve!: Work<Result>['resolve'];
    let reject!: Work<Result>['reject'];
    const promise = new Promise<Result>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    const work = { operation, cancelled, promise, resolve, reject };
    if (this.active) {
      this.cancelPending();
      this.pending = work;
    } else this.start(work);
    return promise;
  }

  cancelPending() {
    const pending = this.pending;
    this.pending = undefined;
    if (!pending) return;
    try {
      pending.resolve(pending.cancelled());
    } catch (error) {
      pending.reject(error);
    }
  }

  private start(work: Work<Result>) {
    this.active = work;
    // Register the active slot before invoking code that can enqueue more work.
    void Promise.resolve()
      .then(work.operation)
      .then(
        (result) => {
          this.finished();
          work.resolve(result);
        },
        (error) => {
          this.finished();
          work.reject(error);
        },
      );
  }

  private finished() {
    this.active = undefined;
    const next = this.pending;
    this.pending = undefined;
    if (next) this.start(next);
  }
}
