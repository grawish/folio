import { useEffect, useState } from 'react';
import { Modal } from './Modal';
import type { SupportPreview, SupportSection } from '../shared/support';

export function SupportBundle({
  onPrepare,
  onClose,
}: {
  onPrepare(): Promise<SupportPreview>;
  onClose(): void;
}) {
  const [preview, setPreview] = useState<SupportPreview>();
  const [selected, setSelected] = useState<SupportSection[]>(['app', 'compiler', 'workspace']);
  const [active, setActive] = useState<SupportSection>('app');
  const [working, setWorking] = useState(false),
    [error, setError] = useState(''),
    [saved, setSaved] = useState(false);
  useEffect(() => {
    let cancelled = false,
      id: string | undefined;
    void onPrepare()
      .then((value) => {
        id = value.id;
        if (cancelled) void window.folio?.cancelSupportBundle(id).catch(() => {});
        else setPreview(value);
      })
      .catch(() => {
        if (!cancelled)
          setError('The support summary could not be prepared. Close this screen and try again.');
      });
    return () => {
      cancelled = true;
      if (id) void window.folio?.cancelSupportBundle(id).catch(() => {});
    };
    // Snapshot only when this screen opens. Later builds must not change the files under review.
  }, []);
  const file = preview?.files.find((f) => f.id === active);
  return (
    <Modal
      wide
      className="support-bundle"
      title="Review support bundle"
      description="Choose what to include. Saving creates a ZIP on your Mac; nothing is sent."
      onClose={onClose}
      dismissible={!working}
    >
      <p className="support-privacy">
        Resume text, PDFs, chats, notes, raw logs, keys, filenames, usernames, paths and environment
        variables are left out.
      </p>
      {preview ? (
        <div className="support-layout">
          <nav aria-label="Support sections">
            {preview.files.map((item) => (
              <div className="support-section" key={item.id}>
                <label>
                  <input
                    type="checkbox"
                    aria-label={`Include ${item.label.toLowerCase()}`}
                    checked={selected.includes(item.id)}
                    disabled={working}
                    onChange={(event) => {
                      setSaved(false);
                      setSelected((previous) =>
                        event.target.checked
                          ? [...previous, item.id]
                          : previous.filter((id) => id !== item.id),
                      );
                    }}
                  />
                  <span>Include</span>
                </label>
                <button
                  className={active === item.id ? 'selected' : ''}
                  aria-pressed={active === item.id}
                  onClick={() => setActive(item.id)}
                >
                  <strong>{item.label}</strong>
                  <small>{item.description}</small>
                </button>
              </div>
            ))}
          </nav>
          <section className="support-preview" aria-label="Support file preview">
            <div>
              <strong>{file?.name}</strong>
              <span>{selected.includes(active) ? 'Included in ZIP' : 'Left out of ZIP'}</span>
            </div>
            <pre tabIndex={0}>{file?.text}</pre>
          </section>
        </div>
      ) : (
        <p role="status">{error ? 'No summary prepared.' : 'Preparing the summary…'}</p>
      )}
      {error && (
        <p role="alert" className="error-text">
          {error}
        </p>
      )}
      <div className="modal-actions">
        <span role="status" className="settings-hint">
          {saved
            ? 'Saved locally. Share the ZIP yourself when you are ready.'
            : `${selected.length} sections selected. Review each included file.`}
        </span>
        <button className="button secondary" disabled={working} onClick={onClose}>
          Close
        </button>
        <button
          className="button primary"
          disabled={!preview || !selected.length || working}
          onClick={() => {
            if (!preview) return;
            setWorking(true);
            setError('');
            setSaved(false);
            void window
              .folio!.exportSupportBundle(preview.id, selected)
              .then(setSaved)
              .catch(() =>
                setError(
                  'The support ZIP could not be saved. Choose another location or close this screen and try again.',
                ),
              )
              .finally(() => setWorking(false));
          }}
        >
          {working ? 'Saving…' : 'Save support ZIP'}
        </button>
      </div>
    </Modal>
  );
}
