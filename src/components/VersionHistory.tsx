import { useEffect, useState } from 'react';
import type { HistoryStorage, PdfAnnotation, VersionInfo, VersionSnapshot } from '../shared/ai';
import { Modal } from './Modal';
import { PdfPreview } from './PdfPreview';

export function VersionHistory({
  projectId,
  versions,
  currentId,
  initialId,
  annotations,
  onRestore,
  onRemove,
  busy,
  canRemove,
  onClose,
}: {
  projectId: string;
  versions: VersionInfo[];
  currentId?: string;
  initialId?: string;
  annotations: PdfAnnotation[];
  onRestore(version: VersionSnapshot): void;
  onRemove(versionId: string): Promise<void>;
  busy: boolean;
  canRemove: boolean;
  onClose(): void;
}) {
  const [selected, setSelected] = useState(initialId ?? versions.at(-2)?.id ?? versions.at(-1)?.id);
  const [storage, setStorage] = useState<HistoryStorage>();
  const [confirmRemoval, setConfirmRemoval] = useState(false);
  const [removalError, setRemovalError] = useState('');
  const [older, setOlder] = useState<VersionSnapshot | null>(null),
    [current, setCurrent] = useState<VersionSnapshot | null>(null),
    [error, setError] = useState('');
  useEffect(() => {
    if (!versions.some((v) => v.id === selected))
      setSelected(versions.at(-2)?.id ?? versions.at(-1)?.id);
  }, [versions, selected]);
  useEffect(() => {
    let cancelled = false;
    setStorage(undefined);
    void window.folio
      ?.historyStorage(projectId)
      .then((value) => {
        if (!cancelled) setStorage(value);
      })
      .catch((error) => {
        if (!cancelled) setRemovalError(error.message);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, versions]);
  useEffect(() => {
    let cancelled = false;
    setOlder(null);
    setCurrent(null);
    setError('');
    if (!selected || !window.folio) return;
    const latest = currentId ?? versions.at(-1)?.id;
    void Promise.all([
      window.folio.readVersion(projectId, selected),
      latest ? window.folio.readVersion(projectId, latest) : Promise.resolve(null),
    ])
      .then(([left, right]) => {
        if (!cancelled) {
          setOlder(left);
          setCurrent(right);
        }
      })
      .catch((error) => {
        if (!cancelled) setError(error.message);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, selected, currentId, versions]);
  return (
    <Modal
      wide
      title="Version history"
      description="Compare saved PDFs. Restoring keeps every earlier version."
      onClose={onClose}
      dismissible={!busy}
    >
      {storage && (
        <p className="history-storage" role="status">
          {storage.versions.length.toLocaleString()} / {storage.versionLimit.toLocaleString()}{' '}
          versions · {(storage.bytes / 1024 / 1024).toFixed(1)} / {storage.limitBytes / 1024 / 1024}{' '}
          MiB of saved source and PDFs. Older versions are kept until you choose to remove them.
          {(storage.bytes >= storage.limitBytes ||
            storage.versions.length >= storage.versionLimit) &&
            ' History is full. Remove older versions before building another PDF.'}
        </p>
      )}
      {!versions.length ? (
        <p>Build a PDF to create your first saved version.</p>
      ) : (
        <div className="history-layout">
          <nav aria-label="Saved versions">
            {[...versions].reverse().map((version, index) => (
              <button
                key={version.id}
                className={version.id === selected ? 'selected' : ''}
                disabled={busy}
                onClick={() => {
                  setSelected(version.id);
                  setConfirmRemoval(false);
                  setRemovalError('');
                }}
              >
                <strong>
                  Version {versions.length - index}
                  {version.id === currentId ? ' · Current PDF' : ''}
                </strong>
                <small>{new Date(version.createdAt).toLocaleString()}</small>
                <span>{version.label}</span>
                <small>{version.verified ? 'Visually checked' : 'Built successfully'}</small>
              </button>
            ))}
          </nav>
          <div className="history-comparison">
            <section>
              <h4>Selected version</h4>
              <PdfPreview
                data={older?.pdf}
                building={!older && !error}
                stale={false}
                status={null}
                versionId={older?.info.id}
                annotations={annotations}
              />
              <div className="history-notes" aria-label="Notes on selected version">
                {annotations
                  .filter((note) => note.versionId === older?.info.id)
                  .map((note) => (
                    <p className="history-note" key={note.id}>
                      Page {note.page} · {note.text || `${note.kind} note`}
                    </p>
                  ))}
              </div>
            </section>
            <section>
              <h4>Current PDF</h4>
              <PdfPreview
                data={current?.pdf}
                building={!current && !error}
                stale={false}
                status={null}
              />
            </section>
          </div>
        </div>
      )}
      {error && (
        <p role="alert" className="error-text">
          {error}
        </p>
      )}
      {confirmRemoval && (
        <div className="history-removal" role="group" aria-label="Confirm history removal">
          <strong>Remove “{versions.find((v) => v.id === selected)?.label}”?</strong>
          <p>
            This removes this version’s saved source, PDF, and visual notes from local history. Sent
            note text stays in chat. Your current source and PDF stay unchanged. This cannot be
            undone here; Save updates the history inside your project folder.
          </p>
          <div className="modal-actions">
            <button
              className="button secondary"
              disabled={busy}
              onClick={() => setConfirmRemoval(false)}
            >
              Keep version
            </button>
            <button
              className="button danger"
              disabled={busy || !canRemove}
              onClick={() => {
                if (!selected) return;
                setRemovalError('');
                void onRemove(selected)
                  .then(() => {
                    setConfirmRemoval(false);
                  })
                  .catch((error) => setRemovalError(error.message));
              }}
            >
              {busy ? 'Removing…' : 'Remove this version'}
            </button>
          </div>
        </div>
      )}
      {removalError && (
        <p role="alert" className="error-text">
          {removalError}
        </p>
      )}
      <div className="modal-actions">
        <span className="settings-hint">Source files and the matching PDF are saved together.</span>
        <button
          className="button secondary"
          disabled={
            busy ||
            !canRemove ||
            !selected ||
            selected === currentId ||
            selected === versions.at(-1)?.id
          }
          onClick={() => {
            setConfirmRemoval(true);
            setRemovalError('');
          }}
        >
          Remove selected version…
        </button>
        <button className="button secondary" disabled={busy} onClick={onClose}>
          Close
        </button>
        <button
          className="button primary"
          disabled={busy || !older || older.info.id === currentId}
          onClick={() => older && onRestore(older)}
        >
          Restore selected version
        </button>
      </div>
    </Modal>
  );
}
