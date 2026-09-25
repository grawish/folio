import { useEffect, useState } from 'react';
import { FolderOpen, LoaderCircle, Trash2 } from 'lucide-react';
import type { InterruptedImport } from '../shared/types';
import { Modal } from './Modal';
import { errorMessage } from '../error-message';

export function InterruptedImports({
  busy,
  error,
  onResume,
  onDiscard,
  onForget,
  onCount,
  onClose,
}: {
  busy: boolean;
  error: string;
  onResume(id: string): void;
  onDiscard(id: string): void;
  onForget(id: string): void;
  onCount(count: number): void;
  onClose(): void;
}) {
  const [items, setItems] = useState<InterruptedImport[]>([]);
  const [loading, setLoading] = useState(true);
  const [localError, setLocalError] = useState('');
  const [confirm, setConfirm] = useState<InterruptedImport | null>(null);
  useEffect(() => {
    if (busy) return;
    let alive = true;
    setLoading(true);
    setLocalError('');
    void window.folio
      ?.interruptedImports()
      .then((items) => {
        if (!alive) return;
        setItems(items);
        onCount(items.length);
      })
      .catch((error) => {
        if (alive) setLocalError(errorMessage(error.message));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [busy, onCount]);
  return (
    <Modal
      wide
      className="import-recovery-modal"
      title="Interrupted imports"
      description="Finish a saved import, or review the copy it left behind."
      dismissible={!busy}
      onClose={onClose}
    >
      <div className="import-recovery-body">
        <p className="settings-hint">
          Your original ZIP and existing projects are kept. Folio checks each unfinished copy before
          changing it.
        </p>
        {(error || localError) && (
          <p className="error-text" role="alert">
            {error || localError}
          </p>
        )}
        {busy ? (
          <p role="status">
            <LoaderCircle className="spin" size={16} /> Updating the import…
          </p>
        ) : loading ? (
          <p role="status">Checking saved imports…</p>
        ) : !items.length ? (
          <p className="empty-inline">No interrupted imports to review.</p>
        ) : null}
        {items.map((item) => (
          <section className="import-recovery-item" key={item.id} aria-label={item.name}>
            <h3>{item.name}</h3>
            <p>{item.message}</p>
            {item.directory && <p className="import-recovery-path">{item.directory}</p>}
            <div className="import-recovery-actions">
              {item.canResume && (
                <button
                  className="button primary"
                  disabled={busy || loading}
                  onClick={() => onResume(item.id)}
                >
                  <FolderOpen size={15} />{' '}
                  {item.state === 'complete' ? 'Open recovered project' : 'Finish import'}
                </button>
              )}
              {item.hasFolder && (
                <button
                  className="button secondary"
                  disabled={busy}
                  onClick={() => {
                    setLocalError('');
                    void window.folio
                      ?.showImportFolder(item.id)
                      .catch((error) => setLocalError(errorMessage(error.message)));
                  }}
                >
                  Show folder
                </button>
              )}
              {item.canDiscard && (
                <button
                  className="button secondary"
                  disabled={busy || loading}
                  onClick={() => onDiscard(item.id)}
                >
                  <Trash2 size={15} />{' '}
                  {item.hasFolder ? 'Move copy to Trash' : 'Discard recovery copy'}
                </button>
              )}
              <button
                className="button secondary"
                disabled={busy || loading}
                onClick={() => setConfirm(item)}
              >
                Keep files & dismiss…
              </button>
            </div>
            {confirm?.id === item.id && (
              <div className="import-recovery-confirm">
                <p>
                  Keep any destination files and delete Folio’s recovery copy. To import again, you
                  will need the original ZIP.
                </p>
                <div className="import-recovery-actions">
                  <button
                    className="button secondary"
                    disabled={busy}
                    onClick={() => setConfirm(null)}
                  >
                    Back
                  </button>
                  <button
                    className="button primary"
                    disabled={busy}
                    onClick={() => {
                      setConfirm(null);
                      onForget(item.id);
                    }}
                  >
                    Keep files & stop recovery
                  </button>
                </div>
              </div>
            )}
          </section>
        ))}
      </div>
      <div className="modal-actions">
        <button className="button primary" disabled={busy} onClick={onClose}>
          Done
        </button>
      </div>
    </Modal>
  );
}
