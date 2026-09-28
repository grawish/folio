import { promises as fs, constants } from 'node:fs';
import path from 'node:path';
import { atomicWrite } from './file-io';
import {
  validatePreferences,
  validatePreferencePatch,
  type Preferences,
} from '../../src/shared/preferences';

// A single app owns the profile. Serialize patches so independent controls do
// not replace one another; acknowledge only after atomic replacement completes.
export class PreferenceStore {
  readonly filename: string;
  private tail: Promise<unknown> = Promise.resolve();
  private value: Preferences | undefined;
  constructor(
    root: string,
    private readonly write = atomicWrite,
  ) {
    this.filename = path.join(root, 'workspace-preferences.json');
  }
  private serial<T>(action: () => Promise<T>): Promise<T> {
    const next = this.tail.catch(() => {}).then(action);
    this.tail = next;
    return next;
  }
  initialize(legacy: unknown): Promise<Preferences> {
    const initial = validatePreferences(legacy);
    return this.serial(async () => {
      if (this.value) return { ...this.value };
      let handle;
      try {
        handle = await fs.open(
          this.filename,
          constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      if (handle) {
        try {
          const stat = await handle.stat();
          if (
            !stat.isFile() ||
            stat.nlink !== 1 ||
            stat.uid !== process.getuid?.() ||
            stat.size > 2048
          )
            throw new Error('Workspace preferences are not a supported settings file.');
          const buffer = Buffer.alloc(2049);
          let length = 0;
          while (length < buffer.length) {
            const read = await handle.read(buffer, length, buffer.length - length, length);
            if (!read.bytesRead) break;
            length += read.bytesRead;
          }
          if (length > 2048) throw new Error('Workspace preferences are too large.');
          const data = JSON.parse(buffer.subarray(0, length).toString('utf8'));
          if (
            !data ||
            Object.keys(data).sort().join(',') !== 'schema,values' ||
            data.schema !== 'folio-preferences-1'
          )
            throw new Error('Unsupported workspace preferences format.');
          this.value = validatePreferences(data.values);
        } finally {
          await handle.close();
        }
      } else {
        await this.write(
          this.filename,
          JSON.stringify({ schema: 'folio-preferences-1', values: initial }),
        );
        this.value = initial;
      }
      return { ...this.value };
    });
  }
  update(value: unknown): Promise<void> {
    const patch = validatePreferencePatch(value);
    return this.serial(async () => {
      if (!this.value) throw new Error('Open workspace preferences before changing them.');
      const next = { ...this.value, ...patch };
      if (JSON.stringify(next) === JSON.stringify(this.value)) return;
      await this.write(
        this.filename,
        JSON.stringify({ schema: 'folio-preferences-1', values: next }),
      );
      this.value = next;
    });
  }
  async flush() {
    try {
      await this.tail;
    } catch (error) {
      // Before startup succeeds there are no preference edits to lose. Let the
      // unopened app close while retaining an unreadable settings file.
      if (this.value) throw error;
    }
  }
}
