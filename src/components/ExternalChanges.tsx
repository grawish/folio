import { useState } from 'react';
import type { Project, ProjectDiskChanges } from '../shared/types';
import { Modal } from './Modal';
import { errorMessage } from '../error-message';

export function ExternalChanges({
  project,
  report,
  busy,
  onCheck,
  onUseDisk,
  onCopy,
  onClose,
}: {
  project: Project;
  report: ProjectDiskChanges;
  busy: boolean;
  onCheck(): Promise<void>;
  onUseDisk(main: string): Promise<void>;
  onCopy(): void;
  onClose(): void;
}) {
  const [selectedMain, setSelectedMain] = useState(project.mainFile);
  const [error, setError] = useState('');
  const mainFile = report.mainFiles.includes(selectedMain)
    ? selectedMain
    : (report.mainFiles[0] ?? '');
  const sourceChanged = report.changes.some((file) => file.kind !== 'project');
  const metadataChanged = report.changes.some((file) => file.kind === 'project');
  const run = async (action: () => Promise<void>) => {
    setError('');
    try {
      await action();
    } catch (e) {
      setError(errorMessage((e as Error).message));
    }
  };
  return (
    <Modal
      title="Files changed outside Folio"
      description="Your editor text is still here. Choose how to continue."
      dismissible={!busy}
      onClose={onClose}
    >
      <div className="external-review">
        {report.error && (
          <p className="error-text" role="alert">
            {report.error}
          </p>
        )}
        <ul className="external-file-list" aria-label="Changed files">
          {report.changes.map((file) => (
            <li key={file.path}>
              <strong>{file.path}</strong>
              <span>
                {file.change} · {file.kind === 'project' ? 'project data' : file.kind}
              </span>
            </li>
          ))}
        </ul>
        {!report.error && !report.changes.length && (
          <p className="file-hint">The project folder now matches the last accepted files.</p>
        )}
        {sourceChanged && (
          <>
            <p className="file-hint">
              Reload reads all source files and current assets from the project folder. Differing
              editor text is kept in Removed files &amp; saved copies. Nothing in the project folder
              is replaced until you save.
            </p>
            <label className="field-label" htmlFor="external-main">
              Main document after reload
            </label>
            <select
              id="external-main"
              className="text-input"
              value={mainFile}
              onChange={(e) => setSelectedMain(e.target.value)}
              disabled={busy}
            >
              {report.mainFiles.map((name) => (
                <option key={name}>{name}</option>
              ))}
            </select>
            {!mainFile && (
              <p className="error-text">
                No .tex document remains on disk. Keep editing to save your current document, or
                restore a file in the folder.
              </p>
            )}
          </>
        )}
        {metadataChanged && (
          <p className="file-hint">
            Project settings, history or saved copies also changed on disk. Reloading source keeps
            your current project data. Saving this folder will still ask before replacing changed
            project data; Save a copy keeps the original folder.
          </p>
        )}
        <p className="file-hint">
          Keep editing leaves disk files unchanged. Saving will ask before replacing outside edits
          and retain replaced source text as a saved copy.
        </p>
        {error && (
          <p className="error-text" role="alert">
            {error}
          </p>
        )}
        <div className="external-review-actions">
          <button className="text-button" disabled={busy} onClick={() => void run(onCheck)}>
            Check again
          </button>
          <button className="text-button" disabled={busy} onClick={onCopy}>
            Save a copy…
          </button>
        </div>
        <div className="modal-actions">
          <button className="button secondary" disabled={busy} onClick={onClose}>
            Keep editing
          </button>
          <button
            className="button primary"
            disabled={busy || !!report.error || !sourceChanged || !mainFile}
            onClick={() => void run(() => onUseDisk(mainFile))}
          >
            {busy ? 'Reloading…' : 'Reload source from disk'}
          </button>
        </div>
      </div>
    </Modal>
  );
}
