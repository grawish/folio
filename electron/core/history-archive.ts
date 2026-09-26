import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { setImmediate as nextTurn } from 'node:timers/promises';
import limits from './history-archive-limits.json';

// The main-process build supplies the equivalent CommonJS module URL.
const workerFile = fileURLToPath(new URL('./history-zip-worker.cjs', import.meta.url));
type Entries = Record<string, Uint8Array>;

export class HistoryArchiver {
  private tail: Promise<void> = Promise.resolve();
  private pending = 0;
  private worker: Worker | undefined;
  private retiring = new Set<Promise<void>>();
  private idle: NodeJS.Timeout | undefined;
  private sequence = 0;
  private closed = false;

  constructor(
    private readonly options: { workerFile?: string; timeoutMs?: number; idleMs?: number } = {},
  ) {}

  // Queue factories, not already loaded 200 MB histories. At most one factory
  // and compressor run at once across every WorkspaceStore in this process.
  run(load: () => Promise<Entries>): Promise<Uint8Array> {
    if (this.closed) return Promise.reject(new Error('History archiving has closed.'));
    if (this.pending >= 4)
      return Promise.reject(
        new Error('The app is finishing other history archives. Try saving again in a moment.'),
      );
    this.pending++;
    const operation = this.tail
      .catch(() => {})
      .then(async () => {
        if (this.closed) throw new Error('History archiving has closed.');
        return this.compress(await load());
      });
    // Keep no archive bytes in the queue after completion. The caller alone
    // owns the result; both outcomes release the next queued request.
    this.tail = operation.then(
      () => {
        this.pending--;
      },
      () => {
        this.pending--;
      },
    );
    return operation;
  }

  async close() {
    this.closed = true;
    await this.tail.catch(() => {});
    if (this.worker) await this.retire(this.worker);
    await Promise.all(this.retiring);
  }

  private async retire(worker: Worker) {
    clearTimeout(this.idle);
    if (this.worker === worker) this.worker = undefined;
    const completion = worker.terminate().then(
      () => {},
      () => {},
    );
    this.retiring.add(completion);
    await completion;
    this.retiring.delete(completion);
  }

  private async getWorker() {
    await Promise.all(this.retiring);
    clearTimeout(this.idle);
    if (!this.worker) {
      const worker = new Worker(this.options.workerFile ?? workerFile, {
        name: 'folio-history-archive',
        execArgv: [],
        env: {},
        resourceLimits: {
          maxOldGenerationSizeMb: 64,
          maxYoungGenerationSizeMb: 16,
          stackSizeMb: 4,
        },
      });
      // Handle idle-worker failures too; the active request has its own handler.
      worker.on('error', () => {
        if (this.worker === worker) this.worker = undefined;
      });
      worker.on('exit', () => {
        if (this.worker === worker) this.worker = undefined;
      });
      this.worker = worker;
    }
    this.worker.ref();
    return this.worker;
  }

  private async compress(entries: Entries): Promise<Uint8Array> {
    const names = Object.keys(entries);
    if (!names.length || names.length > limits.entries)
      throw new Error('History exceeds the archive file-count limit.');
    let bytes = 0;
    for (const name of names) {
      const data = entries[name];
      if (!(data instanceof Uint8Array) || data.byteLength > limits.entryBytes)
        throw new Error('A history entry exceeds the 25 MB archive limit.');
      bytes += data.byteLength;
      if (bytes > limits.expandedBytes)
        throw new Error('History is too large to bundle in this project (200 MB limit).');
    }
    // Node's pooled Buffers cannot safely be transferred. Own dedicated copies;
    // yield between batches so copying many entries does not monopolize the loop.
    const owned: Entries = Object.create(null);
    const transfer: ArrayBuffer[] = [];
    let batch = 0,
      count = 0;
    for (const name of names) {
      const copy = new Uint8Array(entries[name]);
      owned[name] = copy;
      transfer.push(copy.buffer);
      batch += copy.byteLength;
      if (batch >= 1024 * 1024 || ++count >= 32) {
        await nextTurn();
        batch = 0;
        count = 0;
      }
    }
    const worker = await this.getWorker();
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = async (error?: Error, archive?: Uint8Array) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        worker.off('message', message);
        worker.off('error', failed);
        worker.off('exit', exited);
        if (error) {
          await this.retire(worker);
          reject(error);
        } else {
          worker.unref();
          this.idle = setTimeout(() => {
            void this.retire(worker);
          }, this.options.idleMs ?? 5000);
          this.idle.unref();
          resolve(archive!);
        }
      };
      const message = (value: { id?: number; error?: string; archive?: Uint8Array }) => {
        if (value?.id !== id) {
          void finish(new Error('The history worker returned an unexpected response.'));
          return;
        }
        if (value.error) {
          void finish(new Error(value.error));
          return;
        }
        if (
          !(value.archive instanceof Uint8Array) ||
          value.archive.byteLength < 22 ||
          value.archive.byteLength > limits.compressedBytes
        ) {
          void finish(new Error('The history worker returned an invalid archive.'));
          return;
        }
        void finish(undefined, value.archive);
      };
      const failed = () => {
        void finish(new Error('History compression failed. Try saving again.'));
      };
      const exited = () => {
        void finish(new Error('History compression stopped. Try saving again.'));
      };
      const timer = setTimeout(() => {
        void finish(
          new Error(
            'History compression exceeded its time limit. Your project files have not been changed.',
          ),
        );
      }, this.options.timeoutMs ?? 30_000);
      worker.once('message', message);
      worker.once('error', failed);
      worker.once('exit', exited);
      try {
        worker.postMessage({ id, entries: owned, timestamp: Date.now() }, transfer);
      } catch {
        void finish(new Error('History could not be sent for compression. Try saving again.'));
      }
    });
  }
}

export const historyArchiver = new HistoryArchiver();
