import { useState } from 'react';
import { RotateCcw, Trash2 } from 'lucide-react';
import type { Project } from '../shared/types';
import { Modal } from './Modal';

export function FileManager({
  project,
  target,
  onRename,
  onRemove,
  onRestore,
  onDiscard,
  onClose,
}: {
  project: Project;
  target?: string;
  onRename(name: string): void;
  onRemove(replacement?: string): void;
  onRestore(id: string, name: string): void;
  onDiscard(id: string): void;
  onClose(): void;
}) {
  const [name, setName] = useState(target ?? '');
  const [mode, setMode] = useState<'rename' | 'remove' | 'restore' | 'discard'>(
    target ? 'rename' : 'restore',
  );
  const [record, setRecord] = useState<string>();
  const [error, setError] = useState('');
  const alternatives = project.files.filter(
    (file) => file.path !== target && file.path.endsWith('.tex'),
  );
  const [mainFile, setMainFile] = useState(alternatives[0]?.path ?? '');
  const copy = project.removedFiles?.find((file) => file.id === record);
  const run = (operation: () => void) => {
    try {
      operation();
      setError('');
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <Modal
      title={
        target
          ? mode === 'remove'
            ? 'Remove a source file'
            : 'Rename a source file'
          : 'Removed files & saved copies'
      }
      description={
        target ? target : 'Restore a removed file or an earlier copy kept when saving a removal.'
      }
      onClose={onClose}
    >
      {target ? (
        <form
          className="file-manager"
          onSubmit={(event) => {
            event.preventDefault();
            run(() =>
              mode === 'remove' ? onRemove(mainFile || undefined) : onRename(name.trim()),
            );
          }}
        >
          {mode === 'rename' ? (
            <>
              <label className="field-label" htmlFor="rename-source">
                New filename
              </label>
              <input
                id="rename-source"
                className="text-input"
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
              <p className="file-hint">
                Changes are written to disk when you save. Update any references to this filename in
                other source files.
              </p>
            </>
          ) : (
            <>
              <p className="file-hint">
                The current text will move to Removed files. Save to remove the file from its
                project folder. References in other source files stay as written.
              </p>
              {project.mainFile === target && (
                <>
                  <label className="field-label" htmlFor="replacement-main">
                    New main document
                  </label>
                  <select
                    className="text-input"
                    id="replacement-main"
                    value={mainFile}
                    onChange={(e) => setMainFile(e.target.value)}
                  >
                    {alternatives.map((file) => (
                      <option key={file.path}>{file.path}</option>
                    ))}
                  </select>
                  {!alternatives.length && (
                    <p className="error-text">
                      Keep at least one .tex document. Add another document before removing this
                      one.
                    </p>
                  )}
                </>
              )}
            </>
          )}
          {error && (
            <p className="error-text" role="alert">
              {error}
            </p>
          )}
          <div className="modal-actions file-manager-actions">
            {mode === 'rename' && (
              <button
                type="button"
                className="text-button file-remove-action"
                onClick={() => {
                  setMode('remove');
                  setError('');
                }}
              >
                <Trash2 size={14} /> Remove file…
              </button>
            )}
            <button type="button" className="button secondary" onClick={onClose}>
              Cancel
            </button>
            <button
              type="submit"
              className="button primary"
              disabled={mode === 'rename' ? name.trim() === target : !alternatives.length}
            >
              {mode === 'remove' ? 'Move to removed files' : 'Rename file'}
            </button>
          </div>
        </form>
      ) : copy ? (
        <form
          className="file-manager"
          onSubmit={(event) => {
            event.preventDefault();
            run(() => {
              if (mode === 'discard') onDiscard(copy.id);
              else onRestore(copy.id, name.trim());
              setRecord(undefined);
            });
          }}
        >
          <p className="file-copy-title">{copy.path}</p>
          <pre className="file-copy-preview" aria-label="Saved file preview">
            {copy.content.slice(0, 4000)}
            {copy.content.length > 4000 ? '\n… Preview shortened. The full file is saved.' : ''}
          </pre>
          {mode === 'discard' ? (
            <p className="file-hint">
              Delete this saved copy? Current project files and other versions are kept. Save the
              project to keep this change.
            </p>
          ) : (
            <>
              <label className="field-label" htmlFor="restore-source">
                Restore as
              </label>
              <input
                className="text-input"
                id="restore-source"
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
              <p className="file-hint">
                Choose a new name if a file already exists. Restoring never replaces another file.
              </p>
            </>
          )}
          {error && (
            <p className="error-text" role="alert">
              {error}
            </p>
          )}
          <div className="modal-actions">
            <button
              type="button"
              className="button secondary"
              onClick={() => {
                setRecord(undefined);
                setError('');
              }}
            >
              Back
            </button>
            <button type="submit" className="button primary">
              {mode === 'discard' ? 'Delete saved copy' : 'Restore file'}
            </button>
          </div>
        </form>
      ) : (
        <div className="removed-file-list">
          {!project.removedFiles?.length && (
            <p className="file-hint">No removed files or earlier copies yet.</p>
          )}
          {project.removedFiles
            ?.slice()
            .reverse()
            .map((file) => (
              <div className="removed-file-row" key={file.id}>
                <div>
                  <strong>{file.path}</strong>
                  <small>
                    {file.reason === 'disk-copy'
                      ? 'Earlier saved copy'
                      : file.reason === 'editor-copy'
                        ? 'Earlier editor copy'
                        : 'Removed file'}{' '}
                    · {new Date(file.removedAt).toLocaleString()}
                  </small>
                </div>
                <button
                  className="icon-button"
                  aria-label={`Restore ${file.path}`}
                  title="Restore file"
                  onClick={() => {
                    setRecord(file.id);
                    setMode('restore');
                    setName(file.path);
                    setError('');
                  }}
                >
                  <RotateCcw size={16} />
                </button>
                <button
                  className="icon-button"
                  aria-label={`Delete saved copy of ${file.path}`}
                  title="Delete saved copy"
                  onClick={() => {
                    setRecord(file.id);
                    setMode('discard');
                    setError('');
                  }}
                >
                  <Trash2 size={16} />
                </button>
              </div>
            ))}
        </div>
      )}
    </Modal>
  );
}
