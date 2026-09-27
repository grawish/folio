import { app, autoUpdater as nativeUpdater } from 'electron';
import { MacUpdater } from 'electron-updater';
import { CancellationToken } from 'builder-util-runtime';
import { homedir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { updateNetworkUrl } from './update-feed';
import { verifyUpdateArchive, discardUpdateArchive } from './update-archive';
import { requireVerifiedUpdate, type UpdateFeed } from './update-manifest';
import { signedUpdateProvider } from './update-provider';
import type { AppUpdateInstaller } from './update-service';

const execute = promisify(execFile);

/** End-user checks use macOS tools, not Xcode or developer-only dependencies. */
export async function installedUpdateSupport(teamId: string | null) {
  if (!app.isPackaged || process.platform !== 'darwin' || process.arch !== 'arm64')
    return 'Automatic installation requires the signed Apple silicon release of Folio.';
  if (!teamId || !/^[A-Z0-9]{10}$/.test(teamId))
    return 'This preview has not enabled signed app updates. Available downloads are on GitHub.';
  try {
    await execute(
      '/usr/bin/codesign',
      [
        '--verify',
        '--strict',
        '-R',
        `=identifier "app.folio.resume" and anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = "${teamId}"`,
        path.resolve(process.execPath, '../../..'),
      ],
      { timeout: 30000, maxBuffer: 65536 },
    );
    return undefined;
  } catch {
    return 'This copy of Folio could not verify its publisher signature. Reinstall a signed release from GitHub to enable updates.';
  }
}

export class MacAppInstaller implements AppUpdateInstaller {
  private readonly updater = new MacUpdater();
  private readonly cacheRoot = path.join(
    homedir(),
    'Library',
    'Caches',
    'folio-app-updates',
    'pending',
  );
  private downloaded?: { feed: UpdateFeed; file: string };
  private currentFile?: string;
  constructor() {
    this.updater.autoDownload = false;
    this.updater.autoInstallOnAppQuit = false;
    this.updater.autoRunAppAfterInstall = true;
    this.updater.allowPrerelease = true;
    this.updater.allowDowngrade = false;
    // Until signed blockmaps are part of the protocol, use a complete ZIP whose
    // exact bytes are bound by the authenticated SHA-512 checksum.
    this.updater.disableDifferentialDownload = true;
    this.updater.logger = null;
    this.updater.on('error', () => {}); // Methods/native install listeners report errors to the UI.
    this.updater.on('update-downloaded', (event) => {
      this.currentFile = event.downloadedFile;
    });
    // Covers redirects as well as the original request. Do not let the updater
    // forward a download to HTTP, credentials in a URL, or an arbitrary host.
    this.updater.netSession.webRequest.onBeforeRequest((details, callback) => {
      try {
        updateNetworkUrl(details.url);
        callback({ cancel: false });
      } catch {
        callback({ cancel: true });
      }
    });
  }
  async download(
    feed: UpdateFeed,
    signal: AbortSignal,
    progress: (received: number, total: number) => void,
  ) {
    requireVerifiedUpdate(feed);
    if (!feed.release) throw new Error('There is no approved app update.');
    signal.throwIfAborted();
    this.downloaded = undefined;
    this.currentFile = undefined;
    this.updater.setFeedURL({ provider: 'custom', updateProvider: signedUpdateProvider(feed) });
    this.updater.allowDowngrade = false;
    const result = await this.updater.checkForUpdates();
    signal.throwIfAborted();
    if (!result?.isUpdateAvailable || result.updateInfo.version !== feed.release.version)
      throw new Error('The native updater did not accept this release. Check for updates again.');
    const token = new CancellationToken();
    const cancel = () => token.cancel();
    const timeout = setTimeout(cancel, 15 * 60_000);
    let tooLarge = false;
    const onProgress = (value: { transferred: number }) => {
      if (value.transferred > feed.release!.zip.bytes) {
        tooLarge = true;
        token.cancel();
      } else progress(value.transferred, feed.release!.zip.bytes);
    };
    signal.addEventListener('abort', cancel, { once: true });
    this.updater.on('download-progress', onProgress);
    try {
      await this.updater.downloadUpdate(token);
      signal.throwIfAborted();
      if (tooLarge || !this.currentFile)
        throw new Error('The app download did not match its signed size.');
      this.downloaded = { feed, file: this.currentFile };
      await this.verify(feed);
      progress(feed.release.zip.bytes, feed.release.zip.bytes);
    } finally {
      clearTimeout(timeout);
      signal.removeEventListener('abort', cancel);
      this.updater.removeListener('download-progress', onProgress);
    }
  }
  async verify(feed: UpdateFeed) {
    requireVerifiedUpdate(feed);
    if (!feed.release || this.downloaded?.feed !== feed)
      throw new Error('Download this authenticated release before installing it.');
    try {
      await verifyUpdateArchive(this.downloaded.file, this.cacheRoot, feed);
    } catch (error) {
      await discardUpdateArchive(this.downloaded.file, this.cacheRoot).catch(() => {});
      this.downloaded = undefined;
      throw error;
    }
  }

  async install() {
    if (!this.downloaded) throw new Error('Download and verify an app update first.');
    await this.verify(this.downloaded.feed);
    // With autoInstallOnAppQuit=false the native updater has not staged a new
    // app yet. Only the explicit restart action can reach this point.
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        nativeUpdater.removeListener('error', failed);
        nativeUpdater.removeListener('update-downloaded', ready);
      };
      const failed = (error: Error) => {
        cleanup();
        reject(error);
      };
      const ready = () => {
        cleanup();
        try {
          this.updater.quitAndInstall();
          resolve();
        } catch (error) {
          reject(error);
        }
      };
      nativeUpdater.once('error', failed);
      nativeUpdater.once('update-downloaded', ready);
      try {
        nativeUpdater.checkForUpdates();
      } catch (error) {
        failed(error as Error);
      }
    });
  }
}
