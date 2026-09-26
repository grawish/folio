import { useEffect, useRef, useState } from 'react';
import { Download, FolderOpen, Package, RefreshCw, Square } from 'lucide-react';
import type { PackActivity, PackImportPreview, PackLibrary } from '../shared/packs';
import type { RuntimePin } from '../shared/runtime';

const size = (bytes: number) =>
  bytes < 1024 * 1024 ? `${Math.ceil(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
const phases: Record<PackActivity['phase'], string> = {
  catalog: 'Checking the signed catalog…',
  import: 'Checking the pack’s signature and files…',
  download: 'Downloading the pack…',
  assemble: 'Preparing verified resources…',
  copy: 'Preparing a separate compiler copy…',
  check: 'Testing the compiler and pack offline…',
  publish: 'Finishing installation…',
};

export function ResourcePacks({
  current,
  onBegin,
  onBusy,
  onUse,
}: {
  current?: RuntimePin;
  onBegin(): Promise<void>;
  onBusy(value: boolean): void;
  onUse(pin: RuntimePin): void;
}) {
  const [library, setLibrary] = useState<PackLibrary>();
  const [preview, setPreview] = useState<PackImportPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [activity, setActivity] = useState<PackActivity>();
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const active = useRef<string | undefined>(undefined);
  const cancelled = useRef<string | undefined>(undefined);
  const mounted = useRef(true);
  const callbacks = useRef({ onBegin, onBusy });
  callbacks.current = { onBegin, onBusy };
  const run = async (action: (id: string) => Promise<void>) => {
    if (active.current || !window.folio) return;
    const id = crypto.randomUUID();
    active.current = id;
    setBusy(true);
    setError('');
    setNotice('');
    setActivity(undefined);
    callbacks.current.onBusy(true);
    try {
      await callbacks.current.onBegin();
      if (!mounted.current || cancelled.current === id) return;
      await action(id);
    } catch (error) {
      if (mounted.current) setError((error as Error).message);
    } finally {
      if (active.current === id) active.current = undefined;
      if (mounted.current) {
        setBusy(false);
        setActivity(undefined);
      }
      callbacks.current.onBusy(false);
    }
  };
  useEffect(() => {
    mounted.current = true;
    const unsubscribe = window.folio?.onPackProgress((value) => {
      if (active.current === value.id) setActivity(value);
    });
    void run(async () => {
      const result = await window.folio!.listPacks();
      if (mounted.current) setLibrary(result);
    });
    return () => {
      mounted.current = false;
      unsubscribe?.();
    };
  }, []);
  const install = (key: string, source: 'catalog' | 'retained' | 'import') =>
    run(async (id) => {
      const result = await window.folio!.installPack(id, key, source);
      if (mounted.current) {
        setLibrary(result);
        setPreview(null);
        setNotice('Pack installed and tested. Preview it below before using it for this project.');
      }
    });
  return (
    <section className="resource-packs" aria-label="Resource packs">
      <h3>LaTeX resources</h3>
      <p className="settings-hint">
        Add supported packages from a signed pack. Installing one keeps your project’s compiler
        choice unchanged.
      </p>
      <div className="pack-toolbar">
        <button
          className="button secondary small"
          disabled={busy || !window.folio}
          onClick={() =>
            void run(async () => {
              setLibrary(await window.folio!.listPacks());
            })
          }
        >
          Reload saved packs
        </button>
        <button
          className="button secondary small"
          disabled={busy || !library?.catalogAvailable}
          onClick={() =>
            void run(async (id) => {
              setLibrary(await window.folio!.refreshPacks(id));
            })
          }
        >
          <RefreshCw size={15} /> Check for packs
        </button>
        <button
          className="button secondary small"
          disabled={busy || !library?.configured}
          onClick={() =>
            void run(async (id) => {
              const value = await window.folio!.preparePackImport(id);
              if (mounted.current) setPreview(value);
            })
          }
        >
          <FolderOpen size={15} /> Import pack file
        </button>
      </div>
      {busy && (
        <div className="pack-progress" role="status">
          <strong>{activity ? phases[activity.phase] : 'Checking local resources…'}</strong>
          {activity?.total !== undefined && (
            <>
              <progress
                max={activity.total}
                value={activity.completed ?? 0}
                aria-label="Resource pack progress"
              />
              <span>
                {activity.phase === 'download'
                  ? `${size(activity.completed ?? 0)} of ${size(activity.total)}${activity.resumed ? ' · resumed' : ''}`
                  : `${activity.completed ?? 0} of ${activity.total} files`}
              </span>
            </>
          )}
          <button
            className="button secondary small"
            onClick={() => {
              // The draft flush can still be running before native work starts.
              // Keep cancellation here too so that work cannot start afterward.
              cancelled.current = active.current;
              void window
                .folio!.cancelPackOperation()
                .then(() => {
                  setPreview(null);
                  setNotice(
                    'Operation stopped. Reload saved packs to see retained files and the current installation state.',
                  );
                })
                .catch((error) => setError(error.message));
            }}
          >
            <Square size={13} /> Cancel operation
          </button>
        </div>
      )}
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="settings-hint" role="status">
          {notice}
        </p>
      )}
      {library && !library.configured && (
        <p className="settings-hint">
          Pack publishing is being prepared for this development build. Your included compiler
          remains available offline.
        </p>
      )}
      {library?.catalogError && (
        <p role="alert" className="error-text">
          {library.catalogError} Retained signed packs can still be used offline.
        </p>
      )}
      {library?.warnings.map((warning, index) => (
        <p className="error-text" role="alert" key={index}>
          {warning}
        </p>
      ))}
      {preview && (
        <article className="pack-card pack-import" aria-label="Review imported pack">
          <div className="pack-card-heading">
            <Package size={19} />
            <h4>{preview.choice.title}</h4>
            <span className="pack-badge">Signed file</span>
          </div>
          <p>{preview.choice.description}</p>
          <p className="settings-hint">
            {size(preview.choice.bytes)} · Requires {preview.choice.base.bundle} · Adds{' '}
            {preview.choice.packages.join(', ')}
          </p>
          <details>
            <summary>Package notices</summary>
            <textarea readOnly aria-label="Imported pack notices" value={preview.notices} />
          </details>
          <div className="pack-actions">
            <button
              className="button primary small"
              disabled={busy}
              onClick={() => void install(preview.token, 'import')}
            >
              Install reviewed pack
            </button>
            <button
              className="button secondary small"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  await window.folio!.cancelPackOperation();
                  setPreview(null);
                })
              }
            >
              Discard import
            </button>
          </div>
        </article>
      )}
      {library?.choices.map((choice) => (
        <article className="pack-card" key={choice.key} aria-label={choice.title}>
          <div className="pack-card-heading">
            <Package size={19} />
            <h4>{choice.title}</h4>
            <span className="pack-badge">
              {current?.id === choice.key
                ? 'Used by this project'
                : choice.installed
                  ? 'Installed'
                  : choice.retained
                    ? 'Saved on this Mac'
                    : 'Available'}
            </span>
          </div>
          <p>{choice.description}</p>
          <p className="settings-hint">
            {size(choice.bytes)} · {choice.packages.join(', ')}
          </p>
          <p className="settings-hint">
            Requires {choice.base.bundle}.{' '}
            {choice.cachedBytes ? `${size(choice.cachedBytes)} of download saved.` : ''}
          </p>
          {!choice.installed && choice.retained && (
            <p className="settings-hint">{choice.message}</p>
          )}
          <div className="pack-actions">
            {choice.installed && current?.id !== choice.key && (
              <button
                className="button primary small"
                disabled={busy}
                onClick={() => onUse(choice.target)}
              >
                Preview for this project
              </button>
            )}
            {!choice.installed && choice.retained && (
              <button
                className="button primary small"
                disabled={busy}
                onClick={() => void install(choice.key, 'retained')}
              >
                Install saved pack
              </button>
            )}
            {!choice.installed && choice.canDownload && (
              <button
                className="button secondary small"
                disabled={busy}
                onClick={() => void install(choice.key, 'catalog')}
              >
                <Download size={15} />{' '}
                {choice.cachedBytes ? 'Resume and install' : 'Download and install'}
              </button>
            )}
            {choice.catalog && (
              <button
                className="button secondary small"
                disabled={busy}
                onClick={() =>
                  void run(async (id) => {
                    setLibrary(await window.folio!.removePackDownload(id, choice.key));
                    setNotice(
                      'Download cache cleared. Installed compilers and retained signed archives are kept.',
                    );
                  })
                }
              >
                Clear download
              </button>
            )}
          </div>
        </article>
      ))}
      {library?.configured && !library.choices.length && !preview && (
        <p className="settings-hint">
          No packs saved yet. Check the catalog or import a signed pack file from another computer.
        </p>
      )}
      {library?.catalogDate && (
        <p className="settings-hint">
          Catalog published {new Date(library.catalogDate).toLocaleString()}.
        </p>
      )}
    </section>
  );
}
