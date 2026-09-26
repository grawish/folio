import { useEffect, useRef, useState } from 'react';
import { CheckCircle2, FolderOpen, LoaderCircle, RefreshCw } from 'lucide-react';
import { Modal } from './Modal';
import { errorMessage } from '../error-message';
import type {
  InterruptedSave,
  RecoveryVersion,
  SaveRecoveryReview,
  SaveRecoveryResult,
  SaveRecoveryText,
} from '../shared/save-recovery';

const labels: Record<RecoveryVersion, string> = {
  current: 'Current disk copy',
  before: 'Before the save',
  after: 'Attempted save',
};
const versions: RecoveryVersion[] = ['current', 'before', 'after'];
export function SaveRecovery({
  id,
  onPrepare,
  onDone,
}: {
  id: string;
  onPrepare(): Promise<void>;
  onDone(result?: SaveRecoveryResult, attempted?: boolean): Promise<void>;
}) {
  const preparation = useRef<Promise<void> | null>(null);
  const attempted = useRef(false);
  const [items, setItems] = useState<InterruptedSave[]>([]);
  const [record, setRecord] = useState<InterruptedSave | null>(null);
  const [review, setReview] = useState<SaveRecoveryReview | null>(null);
  const [choices, setChoices] = useState<Record<string, RecoveryVersion>>({});
  const [filename, setFilename] = useState('');
  const [view, setView] = useState<RecoveryVersion>('current');
  const [text, setText] = useState<SaveRecoveryText | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const [confirm, setConfirm] = useState(false);
  const [result, setResult] = useState<SaveRecoveryResult | null>(null);
  const api = window.folio!;
  const refresh = async () => {
    setBusy(true);
    setError('');
    try {
      setItems(await api.interruptedSaves(id));
    } catch (e) {
      setError(errorMessage((e as Error).message));
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    let alive = true;
    preparation.current ??= onPrepare();
    void preparation.current
      .then(async () => {
        const next = await api.interruptedSaves(id);
        if (alive) setItems(next);
      })
      .catch((e) => {
        if (alive) setError(errorMessage(e.message));
      })
      .finally(() => {
        if (alive) setBusy(false);
      });
    return () => {
      alive = false;
    };
  }, []);
  const inspect = async (item: InterruptedSave) => {
    setRecord(item);
    setReview(null);
    setText(null);
    setBusy(true);
    setError('');
    setConfirm(false);
    try {
      const next = await api.reviewSave(id, item.id);
      if (!next)
        throw new Error('This save no longer needs recovery. Return to the list and refresh.');
      setReview(next);
      setFilename(next.files[0]?.path ?? '');
      setView('current');
      setChoices(
        Object.fromEntries(
          next.files.map((file) => [
            file.path,
            file.changedAfterward || !file.versions.before.available ? 'current' : 'before',
          ]),
        ),
      );
    } catch (e) {
      setError(errorMessage((e as Error).message));
    } finally {
      setBusy(false);
    }
  };
  const file = review?.files.find((file) => file.path === filename);
  useEffect(() => {
    setText(null);
    if (!record || !review || !file?.versions[view].available || !file.versions[view].exists)
      return;
    let alive = true;
    void api
      .reviewSaveText(id, record.id, review.token, filename, view)
      .then((value) => {
        if (alive) setText(value);
      })
      .catch((e) => {
        if (alive) setError(errorMessage(e.message));
      });
    return () => {
      alive = false;
    };
  }, [id, record, review, filename, view]);
  const show = async (value: string, kind: 'record' | 'project' | 'copies' | 'all-copies') => {
    try {
      await api.showSaveRecoveryFolder(id, value, kind);
    } catch (e) {
      setError(errorMessage((e as Error).message));
    }
  };
  const apply = async () => {
    if (!record || !review) return;
    setBusy(true);
    setError('');
    attempted.current = true;
    try {
      setResult(
        await api.resolveSave(
          id,
          record.id,
          review.token,
          review.files.map((file) => ({ path: file.path, version: choices[file.path] })),
        ),
      );
    } catch (e) {
      setError(errorMessage((e as Error).message));
      setConfirm(false);
    } finally {
      setBusy(false);
    }
  };
  const done = async () => {
    setBusy(true);
    try {
      await onDone(result ?? undefined, attempted.current);
    } catch (e) {
      setError(errorMessage((e as Error).message));
      setBusy(false);
    }
  };
  return (
    <Modal
      wide
      className="save-recovery-modal"
      title={result ? 'Your recovery copies are safe' : 'Recover an interrupted save'}
      description={
        result
          ? 'Your file choices have been saved.'
          : 'Compare the copies, then choose what to keep.'
      }
      dismissible={!busy}
      onClose={() => void done()}
    >
      <div className="save-recovery-body">
        <p className="settings-hint">
          Folio keeps all available file versions and your editor draft in a local backup folder
          before applying your choices. Nothing is sent to AI.
        </p>
        {error && (
          <p className="error-text" role="alert">
            {error}
          </p>
        )}
        {busy && (
          <p role="status">
            <LoaderCircle className="spin" size={16} /> Checking and keeping your files…
          </p>
        )}
        {result ? (
          <div className="save-recovery-finished">
            <CheckCircle2 size={36} />
            <h3>
              {result.project
                ? 'Ready to reopen your project'
                : 'The saved project needs attention'}
            </h3>
            <p>
              {result.warning ||
                'Continue with the files you chose. Earlier versions, your editor source, and conversation copies remain in the backup folder.'}
            </p>
            <button className="button secondary" onClick={() => void show(result.copyId, 'copies')}>
              <FolderOpen size={16} /> Show recovery copies
            </button>
          </div>
        ) : !record ? (
          <div className="save-recovery-list">
            {!busy && !items.length && <p>No interrupted saves to review.</p>}
            {items.map((item) => (
              <article key={item.id}>
                <div>
                  <h3>{item.name}</h3>
                  <p className="save-recovery-path">{item.directory}</p>
                  {item.issue && <p>{item.issue}</p>}
                </div>
                <button
                  className="button secondary"
                  disabled={busy}
                  onClick={() =>
                    void show(item.copyId ?? item.id, item.copyId ? 'copies' : 'record')
                  }
                >
                  Show copies
                </button>
                <button
                  className="button primary"
                  disabled={busy || !!item.issue}
                  onClick={() => void inspect(item)}
                >
                  Review files
                </button>
              </article>
            ))}
          </div>
        ) : review ? (
          <>
            <p className="save-recovery-path">{review.directory}</p>
            {confirm ? (
              <div className="save-recovery-confirm">
                <h3>Apply these file choices?</h3>
                <p>
                  This reopens the selected project. Your current editor draft and available file
                  copies will be kept separately.
                </p>
                <ul>
                  {review.files.map((file) => (
                    <li key={file.path}>
                      <strong>{file.path}</strong>
                      <span>
                        {labels[choices[file.path]]}
                        {!file.versions[choices[file.path]].exists ? ' · File will be absent' : ''}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : (
              <div className="save-recovery-layout">
                <nav aria-label="Recovery files">
                  {review.files.map((item) => (
                    <button
                      key={item.path}
                      className={filename === item.path ? 'selected' : ''}
                      onClick={() => {
                        setFilename(item.path);
                        setView(choices[item.path]);
                      }}
                    >
                      <strong>{item.path}</strong>
                      <small>
                        {item.changedAfterward
                          ? 'Edited after the interruption'
                          : 'Part of the interrupted save'}
                      </small>
                      <span>Keep: {labels[choices[item.path]]}</span>
                    </button>
                  ))}
                </nav>
                {file && (
                  <section className="save-recovery-preview" aria-label="File recovery preview">
                    <h3>{file.path}</h3>
                    <div className="save-recovery-versions">
                      {versions.map((version) => (
                        <div key={version} className={view === version ? 'selected' : ''}>
                          <button
                            disabled={!file.versions[version].available}
                            onClick={() => setView(version)}
                            aria-pressed={view === version}
                          >
                            {labels[version]}
                          </button>
                          <small>
                            {!file.versions[version].available
                              ? 'Missing or damaged'
                              : !file.versions[version].exists
                                ? 'File is absent'
                                : `${file.versions[version].bytes!.toLocaleString()} bytes`}
                          </small>
                          <label>
                            <input
                              type="radio"
                              aria-label={`Keep ${labels[version]} for ${filename}`}
                              name={`choice-${filename}`}
                              checked={choices[filename] === version}
                              disabled={!file.versions[version].available || busy}
                              onChange={() => {
                                setChoices((previous) => ({ ...previous, [filename]: version }));
                                setView(version);
                              }}
                            />
                            Keep this version
                          </label>
                        </div>
                      ))}
                    </div>
                    <div className="save-recovery-code">
                      {!file.versions[view].available ? (
                        <p>This copy cannot be used. The remaining copies are kept.</p>
                      ) : !file.versions[view].exists ? (
                        <p>Keeping this version leaves this file absent from the project.</p>
                      ) : !text ? (
                        <p role="status">Reading this copy…</p>
                      ) : text.text === null ? (
                        <p>
                          This is a binary file or cannot be shown as text. Its exact bytes will be
                          kept.
                        </p>
                      ) : (
                        <>
                          <pre>{text.text || '(Empty file)'}</pre>
                          {text.truncated && (
                            <p className="settings-hint">
                              Preview shortened. Recovery keeps the complete file.
                            </p>
                          )}
                        </>
                      )}
                    </div>
                  </section>
                )}
              </div>
            )}
          </>
        ) : null}
      </div>
      <div className="modal-actions">
        {!result && !record && (
          <button
            className="button secondary"
            disabled={busy}
            onClick={() => void show('', 'all-copies')}
          >
            Show all recovery copies
          </button>
        )}
        {!result && record && (
          <button
            className="button secondary"
            disabled={busy}
            onClick={() => {
              setRecord(null);
              setReview(null);
              setConfirm(false);
              setError('');
            }}
          >
            All saves
          </button>
        )}
        {!result && (
          <button
            className="button secondary"
            disabled={busy}
            onClick={() => (record ? void inspect(record) : void refresh())}
          >
            <RefreshCw size={15} /> Refresh
          </button>
        )}
        {!result && record && (
          <button
            className="button secondary"
            disabled={busy}
            onClick={() => void show(record.id, 'record')}
          >
            Show copies
          </button>
        )}
        <button className="button secondary" disabled={busy} onClick={() => void done()}>
          {result ? 'Done' : 'Close'}
        </button>
        {!result &&
          review &&
          (confirm ? (
            <>
              <button
                className="button secondary"
                disabled={busy}
                onClick={() => setConfirm(false)}
              >
                Back to review
              </button>
              <button className="button primary" disabled={busy} onClick={() => void apply()}>
                Apply and keep backups
              </button>
            </>
          ) : (
            <button
              className="button primary"
              disabled={busy || !!error}
              onClick={() => setConfirm(true)}
            >
              Review choices
            </button>
          ))}
      </div>
    </Modal>
  );
}
