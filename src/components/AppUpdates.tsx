import { useEffect, useState } from 'react';
import { ArrowDownToLine, RefreshCw } from 'lucide-react';
import { errorMessage } from '../error-message';
import { APP_RELEASES_PAGE, type AppUpdateStatus, type UpdatePreferences } from '../shared/updates';

export function AppUpdates({
  onRestart,
  onRestarting,
}: {
  onRestart(): Promise<void>;
  onRestarting(value: boolean): void;
}) {
  const [status, setStatus] = useState<AppUpdateStatus>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    const unsubscribe = window.folio?.onAppUpdate((value) => {
      if (live) setStatus(value);
    });
    void window.folio
      ?.appUpdateStatus()
      .then((value) => {
        if (live) setStatus(value);
      })
      .catch((failure) => {
        if (live) setError(errorMessage(failure.message));
      });
    return () => {
      live = false;
      unsubscribe?.();
    };
  }, []);
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError('');
    try {
      await action();
    } catch (failure) {
      setError(errorMessage((failure as Error).message));
    } finally {
      setBusy(false);
    }
  };
  const configure = (change: Partial<UpdatePreferences>) => {
    if (status)
      void run(async () => {
        const previous = status;
        setStatus({ ...status, ...change });
        try {
          const next = await window.folio?.configureAppUpdates({
            channel: status.channel,
            automatic: status.automatic,
            ...change,
          });
          if (next) setStatus(next);
        } catch (failure) {
          setStatus(previous);
          throw failure;
        }
      });
  };
  const active = busy || ['checking', 'downloading', 'restarting'].includes(status?.phase ?? '');
  return (
    <section aria-label="App updates" className="app-updates">
      <h3>App updates</h3>
      <p className="settings-hint">
        Get new versions of Folio. You choose when to download and restart.
      </p>
      {!window.folio && <p>Open the desktop app to manage updates.</p>}
      {status && (
        <>
          <div className="setting-row">
            <div>
              <strong>Update channel</strong>
              <p>Stable is the regular release. Beta lets you try upcoming changes.</p>
            </div>
            <select
              aria-label="Update channel"
              value={status.channel}
              disabled={active}
              onChange={(event) =>
                configure({ channel: event.target.value as UpdatePreferences['channel'] })
              }
            >
              <option value="stable">Stable</option>
              <option value="beta">Beta</option>
            </select>
          </div>
          <div className="setting-row">
            <div>
              <strong>Check automatically</strong>
              <p>
                Check after launch and every six hours. Downloads and restarts always need your
                click.
              </p>
            </div>
            <input
              type="checkbox"
              aria-label="Check for app updates automatically"
              checked={status.automatic}
              disabled={active}
              onChange={(event) => configure({ automatic: event.target.checked })}
            />
          </div>
          <p className="settings-hint">
            Installed version: {status.currentVersion}. Switching channels never installs an older
            version.
          </p>
          {status.installReason && <p className="settings-hint">{status.installReason}</p>}
          {status.previousAttempt && <p className="settings-hint">{status.previousAttempt}</p>}
          <p role={status.phase === 'error' ? 'alert' : 'status'}>{status.message}</p>
          {status.phase === 'downloading' && (
            <>
              <progress
                aria-label="App update download"
                max={status.total ?? 1}
                value={status.received ?? 0}
              />
              <p className="settings-hint">
                {Math.floor((status.received ?? 0) / 1024 ** 2)} of{' '}
                {Math.ceil((status.total ?? 0) / 1024 ** 2)} MB
              </p>
            </>
          )}
          {status.releaseNotes && (
            <details>
              <summary>What’s new in {status.version}</summary>
              <p className="update-release-notes">{status.releaseNotes}</p>
            </details>
          )}
          <div className="modal-actions">
            <button
              className="button secondary small"
              disabled={active}
              onClick={() =>
                void run(async () => {
                  await window.folio?.checkAppUpdates();
                })
              }
            >
              <RefreshCw size={15} /> Check for updates
            </button>
            {status.phase === 'available' && status.canInstall && (
              <button
                className="button primary small"
                disabled={active}
                onClick={() =>
                  void run(async () => {
                    await window.folio?.downloadAppUpdate();
                  })
                }
              >
                <ArrowDownToLine size={15} /> Download update
              </button>
            )}
            {status.phase === 'downloading' && (
              <button
                className="button secondary small"
                onClick={() =>
                  void window.folio
                    ?.cancelAppUpdate()
                    .catch((failure) => setError(errorMessage(failure.message)))
                }
              >
                Cancel download
              </button>
            )}
            {status.phase === 'downloaded' && (
              <button
                className="button primary small"
                disabled={active}
                onClick={() =>
                  void run(async () => {
                    onRestarting(true);
                    try {
                      await onRestart();
                    } catch (failure) {
                      onRestarting(false);
                      throw failure;
                    }
                  })
                }
              >
                Save recovery & restart
              </button>
            )}
          </div>
          <p className="settings-hint">
            Before restarting, Folio saves your source draft, chat, PDF notes and chat draft
            locally. Use Save to also update your project folder.
          </p>
        </>
      )}
      {error && error !== status?.message && <p role="alert">{error}</p>}
      <button
        className="button secondary small"
        onClick={() =>
          void window.folio
            ?.openExternal(APP_RELEASES_PAGE)
            .catch((failure) => setError(errorMessage(failure.message)))
        }
      >
        Downloads on GitHub
      </button>
      <p className="settings-hint">
        Update checks contact GitHub. Your resume, chat and local rollout ID are not sent.
      </p>
    </section>
  );
}
