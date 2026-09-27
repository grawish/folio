import { randomBytes } from 'node:crypto';
import type { AppUpdateStatus, UpdatePreferences } from '../../src/shared/updates';
import { APP_DATA_EPOCH } from '../../src/shared/updates';
import { packFile, savePackFile } from './pack-io';
import { fetchUpdateFeed, type UpdateFetch } from './update-feed';
import {
  UpdateVerifier,
  advanceUpdateCheckpoint,
  requireVerifiedUpdate,
  selectAppUpdate,
  updateChannel,
  updateVersion,
  type FeedCheckpoint,
  type UpdateFeed,
  type UpdateTrust,
} from './update-manifest';

export interface AppUpdateInstaller {
  download(
    feed: UpdateFeed,
    signal: AbortSignal,
    progress: (received: number, total: number) => void,
  ): Promise<void>;
  verify(feed: UpdateFeed): Promise<void>;
  install(): Promise<void>;
}
type UpdateRecord = {
  schemaVersion: 1;
  preferences: UpdatePreferences;
  cohort: string;
  checkpoints: Partial<Record<'stable' | 'beta', FeedCheckpoint>>;
  attempt?: { version: string; startedAt: string };
};
type Options = {
  version: string;
  system: string;
  installer?: AppUpdateInstaller;
  installReason?: string;
  request?: UpdateFetch;
  now?: () => number;
  onChange?(status: AppUpdateStatus): void;
};

export class AppUpdates {
  private readonly verifier: UpdateVerifier;
  private readonly now: () => number;
  private record!: UpdateRecord;
  private loaded?: Promise<void>;
  private selected?: UpdateFeed;
  private activity?: AbortController;
  private pending?: Promise<unknown>;
  private value: AppUpdateStatus;
  constructor(
    private readonly root: string,
    private readonly trust: UpdateTrust,
    private readonly options: Options,
  ) {
    this.verifier = new UpdateVerifier(trust);
    this.now = options.now ?? Date.now;
    this.value = {
      currentVersion: updateVersion(options.version),
      channel: 'stable',
      automatic: false,
      phase: 'idle',
      canInstall: !!options.installer,
      installReason: options.installReason,
      message: 'Check for a new version of Folio.',
    };
  }
  private async load() {
    if (!this.loaded)
      this.loaded = (async () => {
        const bytes = await packFile(this.root, 'state.json', 16 * 1024);
        if (!bytes) {
          this.record = {
            schemaVersion: 1,
            preferences: { channel: 'stable', automatic: false },
            cohort: randomBytes(32).toString('hex'),
            checkpoints: {},
          };
          await this.persist();
        } else {
          const data = JSON.parse(bytes.toString('utf8')) as UpdateRecord;
          if (
            !data ||
            data.schemaVersion !== 1 ||
            !data.preferences ||
            typeof data.preferences.automatic !== 'boolean' ||
            !/^[0-9a-f]{64}$/.test(data.cohort) ||
            !data.checkpoints ||
            Array.isArray(data.checkpoints) ||
            typeof data.checkpoints !== 'object' ||
            Object.keys(data.checkpoints).some((key) => key !== 'stable' && key !== 'beta')
          )
            throw new Error(
              'The saved update settings are damaged. App updates have been stopped.',
            );
          updateChannel(data.preferences.channel);
          for (const checkpoint of Object.values(data.checkpoints))
            if (
              !checkpoint ||
              !Number.isSafeInteger(checkpoint.sequence) ||
              checkpoint.sequence < 1 ||
              !/^[0-9a-f]{64}$/.test(checkpoint.digest)
            )
              throw new Error('The saved update verification record is damaged.');
          if (data.attempt) {
            updateVersion(data.attempt.version);
            if (
              typeof data.attempt.startedAt !== 'string' ||
              !Number.isFinite(Date.parse(data.attempt.startedAt))
            )
              throw new Error('The saved update restart record is damaged.');
          }
          this.record = data;
        }
        Object.assign(this.value, this.record.preferences);
        if (this.record.attempt)
          this.value.previousAttempt =
            this.record.attempt.version === this.options.version
              ? `Folio was updated to ${this.options.version}. Your local draft and conversation are available for recovery.`
              : `The update to ${this.record.attempt.version} did not finish. Your local recovery data was kept. Check for updates to try again.`;
      })();
    await this.loaded;
  }
  private persist() {
    return savePackFile(this.root, 'state.json', JSON.stringify(this.record));
  }
  private change(change: Partial<AppUpdateStatus>) {
    this.value = { ...this.value, ...change };
    this.options.onChange?.({ ...this.value });
  }
  async status() {
    await this.load();
    return { ...this.value };
  }
  private async run(action: (signal: AbortSignal) => Promise<void>) {
    await this.load();
    if (this.pending) throw new Error('Wait for the current app update operation to finish.');
    const controller = new AbortController();
    this.activity = controller;
    const task = Promise.resolve().then(() => action(controller.signal));
    this.pending = task;
    try {
      await task;
    } catch (error) {
      this.change({
        phase: 'error',
        message: controller.signal.aborted
          ? 'Update download cancelled. Check for updates to try again.'
          : (error as Error).message,
      });
      throw error;
    } finally {
      this.pending = undefined;
      this.activity = undefined;
    }
    return { ...this.value };
  }
  async configure(value: UpdatePreferences) {
    return this.run(async () => {
      const channel = updateChannel(value?.channel);
      if (typeof value.automatic !== 'boolean')
        throw new Error('Choose whether to check for updates automatically.');
      const previous = this.record.preferences;
      this.record.preferences = { channel, automatic: value.automatic };
      try {
        await this.persist();
      } catch (error) {
        this.record.preferences = previous;
        throw error;
      }
      if (channel !== previous.channel) {
        this.selected = undefined;
        this.change({
          phase: 'idle',
          message: 'Check the selected channel for a newer release.',
          version: undefined,
          releaseNotes: undefined,
          releasePage: undefined,
          received: undefined,
          total: undefined,
        });
      }
      this.change(this.record.preferences);
    });
  }
  async check() {
    return this.run(async (signal) => {
      this.selected = undefined;
      this.change({
        phase: 'checking',
        message: 'Checking signed release information…',
        version: undefined,
        releaseNotes: undefined,
        releasePage: undefined,
        received: undefined,
        total: undefined,
      });
      if (!Object.keys(this.trust.keys).length)
        throw new Error(
          'Automatic app releases are not configured for this preview. Use the GitHub releases page for available downloads.',
        );
      const channel = this.record.preferences.channel;
      const bytes = await fetchUpdateFeed(this.trust.feeds[channel], signal, this.options.request);
      const feed = this.verifier.verify(bytes, channel, this.now());
      const checkpoint = advanceUpdateCheckpoint(feed, this.record.checkpoints[channel]);
      const previous = this.record.checkpoints[channel];
      this.record.checkpoints[channel] = checkpoint;
      try {
        await this.persist();
      } catch (error) {
        this.record.checkpoints[channel] = previous;
        throw error;
      }
      signal.throwIfAborted();
      const phase = selectAppUpdate(
        feed,
        {
          version: this.options.version,
          system: this.options.system,
          dataEpoch: APP_DATA_EPOCH,
          cohort: this.record.cohort,
        },
        this.now(),
      );
      this.selected = feed;
      const release = feed.release;
      this.change({
        phase,
        checkedAt: new Date(this.now()).toISOString(),
        version: release?.version,
        releaseNotes: release?.notes,
        releasePage: release?.releasePage,
        message:
          phase === 'available'
            ? `Folio ${release!.version} is available.`
            : phase === 'waiting'
              ? 'A newer release is rolling out gradually. Check again later.'
              : phase === 'incompatible'
                ? 'This release needs a newer Mac system or a different local data format. Keep using your installed version.'
                : !release
                  ? 'There is no approved app update in this channel yet.'
                  : 'No newer version is available in this channel.',
      });
    });
  }
  private installable() {
    if (!this.options.installer)
      throw new Error(
        this.options.installReason ?? 'This build cannot install app updates automatically.',
      );
    const feed = this.selected;
    if (!feed?.release) throw new Error('Check for an available update first.');
    requireVerifiedUpdate(feed, this.now());
    if (
      feed.channel !== this.record.preferences.channel ||
      selectAppUpdate(
        feed,
        {
          version: this.options.version,
          system: this.options.system,
          dataEpoch: APP_DATA_EPOCH,
          cohort: this.record.cohort,
        },
        this.now(),
      ) !== 'available'
    )
      throw new Error('This update is no longer eligible. Check for updates again.');
    return { feed, installer: this.options.installer };
  }
  async download() {
    return this.run(async (signal) => {
      if (this.value.phase !== 'available') throw new Error('Check for an available update first.');
      const { feed: offered, installer } = this.installable();
      // The user may leave an offer open for hours. Authenticate the channel
      // again before spending bandwidth or using a withdrawn/replaced artifact.
      const bytes = await fetchUpdateFeed(
        this.trust.feeds[offered.channel],
        signal,
        this.options.request,
      );
      const feed = this.verifier.verify(bytes, offered.channel, this.now());
      const previous = this.record.checkpoints[feed.channel];
      this.record.checkpoints[feed.channel] = advanceUpdateCheckpoint(feed, previous);
      try {
        await this.persist();
      } catch (error) {
        this.record.checkpoints[feed.channel] = previous;
        throw error;
      }
      if (
        JSON.stringify(feed.release?.zip) !== JSON.stringify(offered.release!.zip) ||
        feed.release?.version !== offered.release!.version
      )
        throw new Error('The offered release changed or was withdrawn. Check for updates again.');
      this.selected = feed;
      this.installable();
      this.change({
        phase: 'downloading',
        message: `Downloading Folio ${feed.release!.version}…`,
        received: 0,
        total: feed.release!.zip.bytes,
      });
      await installer.download(feed, signal, (received, total) => this.change({ received, total }));
      signal.throwIfAborted();
      await installer.verify(feed);
      this.change({
        phase: 'downloaded',
        message:
          'Update downloaded and verified. Save your recovery copy and restart when you are ready.',
      });
    });
  }
  async restart(prepareRecovery: () => Promise<void>) {
    return this.run(async () => {
      if (this.value.phase !== 'downloaded')
        throw new Error('Download and verify an update before restarting.');
      const { feed, installer } = this.installable();
      await installer.verify(feed);
      this.change({
        phase: 'restarting',
        message: 'Saving your draft, conversation and PDF notes before restarting…',
      });
      await prepareRecovery();
      requireVerifiedUpdate(feed, this.now());
      this.record.attempt = {
        version: feed.release!.version,
        startedAt: new Date(this.now()).toISOString(),
      };
      await this.persist();
      // Never reach the native installer when recovery or the restart journal
      // could not be saved. A normal app quit never invokes this operation.
      await installer.install();
    });
  }
  async cancel() {
    if (this.value.phase === 'restarting') throw new Error('Folio is preparing to restart.');
    this.activity?.abort();
    await this.pending?.catch(() => {});
  }
}
