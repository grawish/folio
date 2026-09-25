import { useState } from 'react';
import { FolderOpen, LoaderCircle } from 'lucide-react';
import { Modal } from './Modal';
import type { ProjectImportPreview } from '../shared/types';
import { errorMessage } from '../error-message';

export function ImportProjectDialog({
  preview,
  onImport,
  onClose,
}: {
  preview: ProjectImportPreview;
  onImport(mainFile: string): Promise<void>;
  onClose(): void;
}) {
  const [mainFile, setMainFile] = useState(preview.suggestedMain);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const size =
    preview.bytes < 1024 * 1024
      ? `${Math.max(1, Math.ceil(preview.bytes / 1024))} KB`
      : `${(preview.bytes / 1024 / 1024).toFixed(1)} MB`;
  return (
    <Modal
      title="Import a resume project"
      description="Choose the document that builds your PDF."
      dismissible={!busy}
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <form
        className="project-import"
        onSubmit={(event) => {
          event.preventDefault();
          if (busy) return;
          setBusy(true);
          setError('');
          void onImport(mainFile)
            .catch((e) => setError(errorMessage(e.message)))
            .finally(() => setBusy(false));
        }}
      >
        <p className="import-name">{preview.name}</p>
        <p className="import-summary">
          {preview.sourceCount} source {preview.sourceCount === 1 ? 'file' : 'files'} ·{' '}
          {preview.assetCount} {preview.assetCount === 1 ? 'asset' : 'assets'} · {size}
        </p>
        <label className="field-label" htmlFor="import-main">
          Main document
        </label>
        <select
          id="import-main"
          className="text-input"
          value={mainFile}
          disabled={busy}
          autoFocus
          onChange={(event) => setMainFile(event.target.value)}
        >
          {preview.mainFiles.map((name) => (
            <option key={name}>{name}</option>
          ))}
        </select>
        <p className="import-summary">
          A new folder will be created in the location you choose.
          {preview.hasHistory
            ? ' Saved chat, PDF notes, and version history will come with it.'
            : ''}
        </p>
        {!!preview.skipped.length && (
          <details className="import-skipped">
            <summary>
              {preview.skipped.length} unsupported or hidden{' '}
              {preview.skipped.length === 1 ? 'file' : 'files'} will be skipped
            </summary>
            <ul>
              {preview.skipped.map((name) => (
                <li key={name}>{name}</li>
              ))}
            </ul>
          </details>
        )}
        {error && (
          <p className="error-text" role="alert">
            {error}
          </p>
        )}
        <div className="modal-actions">
          <button type="button" className="button secondary" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="button primary" disabled={busy}>
            {busy ? <LoaderCircle size={15} className="spin" /> : <FolderOpen size={15} />}
            {busy ? 'Importing…' : 'Choose location & import'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
