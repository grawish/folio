import { Provider } from 'electron-updater/out/providers/Provider';
import type { ProviderRuntimeOptions } from 'electron-updater/out/providers/Provider';
import type { UpdateInfo } from 'builder-util-runtime';
import { requireVerifiedUpdate, type UpdateFeed } from './update-manifest';

/** One immutable authenticated snapshot; no unsigned YAML is fetched later. */
export function signedUpdateProvider(feed: UpdateFeed, now: () => number = Date.now) {
  requireVerifiedUpdate(feed, now());
  const release = feed.release;
  if (!release) throw new Error('There is no approved update to download.');
  const file = Object.freeze({
    url: release.zip.url,
    sha512: release.zip.sha512,
    size: release.zip.bytes,
  });
  const info: UpdateInfo = Object.freeze({
    version: release.version,
    releaseDate: feed.issuedAt,
    releaseNotes: release.notes,
    minimumSystemVersion: release.minimumSystemVersion,
    path: file.url,
    sha512: file.sha512,
    files: Object.freeze([file]) as unknown as UpdateInfo['files'],
  });
  return class SignedUpdateProvider extends Provider<UpdateInfo> {
    constructor(_options: unknown, _updater: unknown, runtime: ProviderRuntimeOptions) {
      super(runtime);
    }
    async getLatestVersion() {
      requireVerifiedUpdate(feed, now());
      return info;
    }
    resolveFiles(value: UpdateInfo) {
      requireVerifiedUpdate(feed, now());
      if (value !== info) throw new Error('Update information changed after authentication.');
      return [{ url: new URL(file.url), info: file }];
    }
  };
}
