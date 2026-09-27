import type { EventEmitter } from 'node:events';

export const UPDATE_STAGE_TIMEOUT_MS = 120_000;
export const UPDATE_REOPEN_REASON = 'Quit and reopen Folio before trying another app update.';

export class UpdateRestartRequired extends Error {
  constructor(reason: string, options?: ErrorOptions) {
    super(
      `${reason} You can keep working. Save your changes, then quit and reopen Folio before retrying. macOS may finish this update when Folio closes.`,
      options,
    );
    // Keep Error.name standard: Electron includes it in the rejected IPC text.
    // The service distinguishes this failure with instanceof, not a UI prefix.
  }
}

type NativeUpdater = Pick<EventEmitter, 'on' | 'removeListener'> & {
  checkForUpdates(): void;
};

/** Electron's native events carry no request ID and its API has no cancel method.
 * Never start a second native attempt in this process: an old ready event could
 * otherwise restart the app for a different download after the user resumes work.
 */
export class NativeUpdateStaging {
  private started = false;
  constructor(private readonly native: NativeUpdater) {}

  assertAvailable() {
    if (this.started)
      throw new UpdateRestartRequired('Folio already tried to prepare an app update.');
  }

  async install(quitAndInstall: () => void) {
    this.assertAvailable();
    this.started = true;
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        clearTimeout(deadline);
        this.native.removeListener('error', failed);
        this.native.removeListener('update-not-available', unavailable);
        this.native.removeListener('update-downloaded', ready);
      };
      const failed = (error: unknown) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(
          error instanceof UpdateRestartRequired
            ? error
            : new UpdateRestartRequired('macOS could not prepare the app update.', {
                cause: error,
              }),
        );
      };
      const unavailable = () =>
        failed(new UpdateRestartRequired('macOS did not find the downloaded app update.'));
      const ready = () => {
        if (settled) return;
        // Remove ready before handing off, but keep error handling during the
        // synchronous quit call. A duplicate event must not request a second quit.
        this.native.removeListener('update-downloaded', ready);
        try {
          quitAndInstall();
          if (!settled) {
            settled = true;
            cleanup();
            resolve();
          }
        } catch (error) {
          failed(error);
        }
      };
      const deadline = setTimeout(
        () =>
          failed(new UpdateRestartRequired('App update preparation took longer than two minutes.')),
        UPDATE_STAGE_TIMEOUT_MS,
      );
      this.native.on('error', failed);
      this.native.on('update-not-available', unavailable);
      this.native.on('update-downloaded', ready);
      try {
        this.native.checkForUpdates();
      } catch (error) {
        failed(error);
      }
    });
  }
}
