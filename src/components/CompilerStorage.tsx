import { useEffect, useState } from 'react';
import type { CompilerStorage as Storage, CompilerStorageEntry } from '../shared/compiler-storage';
const size = (bytes: number) =>
  bytes >= 1024 ** 3
    ? `${(bytes / 1024 ** 3).toFixed(2)} GiB`
    : `${(bytes / 1024 ** 2).toFixed(1)} MiB`;

export function CompilerStorage({
  onBegin,
  onBusy,
}: {
  onBegin(): Promise<void>;
  onBusy(value: boolean): void;
}) {
  const [storage, setStorage] = useState<Storage>();
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const refresh = async () => {
    if (!window.folio) throw new Error('Open the desktop app to review compiler storage.');
    setStorage(await window.folio.compilerStorage());
  };
  useEffect(() => {
    let cancelled = false;
    void window.folio
      ?.compilerStorage()
      .then((value) => {
        if (!cancelled) setStorage(value);
      })
      .catch((error) => {
        if (!cancelled) setError(error.message);
      });
    return () => {
      cancelled = true;
    };
  }, []);
  const review = async (entry?: CompilerStorageEntry) => {
    if (busy) return;
    setBusy(true);
    onBusy(true);
    setError('');
    setMessage('');
    try {
      await onBegin();
      if (entry && (await window.folio!.removeStoredCompiler(entry.key, entry.token)))
        setMessage('Compiler files removed. Resume files and recorded compiler choices were kept.');
      await refresh();
    } catch (error) {
      setError((error as Error).message);
      await refresh().catch(() => {});
    } finally {
      setBusy(false);
      onBusy(false);
    }
  };
  return (
    <section aria-label="Compiler storage">
      <h3>Storage</h3>
      <p className="settings-hint">
        Older compilers let saved resumes keep their original PDF layout. Remove one only when you
        no longer need it.
      </p>
      <div className="setting-row">
        <div>
          <strong>Local compiler files</strong>
          <p>
            {storage
              ? `${size(storage.bytes)} used · ${size(storage.installationBudgetBytes)} installation budget`
              : 'Measuring compiler files…'}
          </p>
        </div>
        <button className="button secondary" disabled={busy} onClick={() => void review()}>
          Refresh storage
        </button>
      </div>
      <p className="settings-hint">
        Counts compiler copies and offline checks in Folio’s data folder. The app, resume folders,
        history and downloaded packs are separate. Sizes are logical bytes; your Mac may share
        storage between copies.
      </p>
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
      {message && <p role="status">{message}</p>}
      {busy && <p role="status">Reviewing compiler storage…</p>}
      {storage?.entries.map((entry) => (
        <div
          className="setting-row compiler-storage-entry"
          key={entry.key}
          data-compiler-key={entry.key}
        >
          <div>
            <strong>
              {entry.unfinishedRemoval
                ? 'Unfinished removal'
                : entry.pin
                  ? `Tectonic ${entry.pin.version} · ${entry.pin.bundle}`
                  : 'Unrecognized compiler files'}
            </strong>
            <p>
              {size(entry.bytes)} · {entry.copies} {entry.copies === 1 ? 'copy' : 'copies'} ·{' '}
              {(entry.pin?.id ?? entry.key).slice(0, 12)}
            </p>
            {entry.protectedReason && <p>{entry.protectedReason}</p>}
          </div>
          <button
            className="button secondary"
            disabled={busy || !!entry.protectedReason}
            onClick={() => void review(entry)}
          >
            {entry.unfinishedRemoval ? 'Finish removal…' : 'Remove…'}
          </button>
        </div>
      ))}
      <p className="settings-hint">
        Before preparing another copy, Folio checks this budget and free disk space. It never
        automatically deletes old compiler versions.
      </p>
    </section>
  );
}
