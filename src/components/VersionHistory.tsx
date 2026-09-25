import { useEffect, useState } from 'react';
import type { PdfAnnotation, VersionInfo, VersionSnapshot } from '../shared/ai';
import { Modal } from './Modal';
import { PdfPreview } from './PdfPreview';

export function VersionHistory({
  projectId,
  versions,
  currentId,
  initialId,
  annotations,
  onRestore,
  onClose,
}: {
  projectId: string;
  versions: VersionInfo[];
  currentId?: string;
  initialId?: string;
  annotations: PdfAnnotation[];
  onRestore(version: VersionSnapshot): void;
  onClose(): void;
}) {
  const [selected, setSelected] = useState(initialId ?? versions.at(-2)?.id ?? versions.at(-1)?.id);
  const [older, setOlder] = useState<VersionSnapshot | null>(null),
    [current, setCurrent] = useState<VersionSnapshot | null>(null),
    [error, setError] = useState('');
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
    >
      {!versions.length ? (
        <p>Build a PDF to create your first saved version.</p>
      ) : (
        <div className="history-layout">
          <nav aria-label="Saved versions">
            {[...versions].reverse().map((version, index) => (
              <button
                key={version.id}
                className={version.id === selected ? 'selected' : ''}
                onClick={() => setSelected(version.id)}
              >
                <strong>
                  Version {versions.length - index}
                  {version.id === currentId ? ' · Current PDF' : ''}
                </strong>
                <small>{new Date(version.createdAt).toLocaleString()}</small>
                <span>{version.label}</span>
                {version.verified && <small>Visually checked</small>}
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
      <div className="modal-actions">
        <span className="settings-hint">Source files and the matching PDF are saved together.</span>
        <button className="button secondary" onClick={onClose}>
          Close
        </button>
        <button
          className="button primary"
          disabled={!older || older.info.id === currentId}
          onClick={() => older && onRestore(older)}
        >
          Restore selected version
        </button>
      </div>
    </Modal>
  );
}
