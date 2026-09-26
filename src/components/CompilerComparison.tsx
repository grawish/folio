import { useState } from 'react';
import type { CompilerComparison as Comparison } from '../shared/migration';
import type { RuntimePin } from '../shared/runtime';
import { Modal } from './Modal';
import { PdfPreview } from './PdfPreview';

export function CompilerComparison({
  from,
  to,
  onPrepare,
  onApply,
  onClose,
  onShowBackup,
  isPack = false,
}: {
  from?: RuntimePin;
  to?: RuntimePin;
  onPrepare(): Promise<Comparison>;
  onApply(comparison: Comparison): Promise<void>;
  onClose(): void;
  onShowBackup(id: string): Promise<void>;
  isPack?: boolean;
}) {
  const [comparison, setComparison] = useState<Comparison>();
  const [working, setWorking] = useState(false);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState('');
  return (
    <Modal
      wide
      className="compiler-comparison"
      title="Compare compilers"
      description={
        isPack
          ? 'Preview the installed pack before changing this project’s compiler.'
          : 'Review both PDFs before changing how this resume is built.'
      }
      onClose={onClose}
      dismissible={!applying}
    >
      {comparison ? (
        <>
          <p className="settings-hint">
            A backup of your source, assets and saved history is ready. The preview PDF
            {comparison.baseline === 'build-error'
              ? ' and the earlier build error are'
              : 's are'}{' '}
            kept with it.
          </p>
          {comparison.baseline === 'saved-pdf' && (
            <p role="status" className="compiler-comparison-notice">
              The recorded compiler is unavailable. The left side shows a saved PDF matching this
              source; it may use earlier assets. Check every page before applying.
            </p>
          )}
          <div className="history-comparison">
            <section>
              <h4>
                {comparison.baseline === 'saved-pdf'
                  ? 'Before · saved PDF'
                  : 'Before · recorded compiler'}
              </h4>
              <p className="settings-hint">
                Tectonic {from?.version} · {from?.bundle}
              </p>
              {comparison.baseline === 'build-error' ? (
                <div className="pack-baseline-error" role="status">
                  <strong>No before PDF is available for this source.</strong>
                  <p>
                    The recorded compiler could not build it. Check the new PDF carefully before
                    choosing to use this pack.
                  </p>
                  <details>
                    <summary>Show original build error</summary>
                    <pre>{comparison.beforeError}</pre>
                  </details>
                </div>
              ) : (
                <PdfPreview data={comparison.before} building={false} stale={false} status={null} />
              )}
            </section>
            <section>
              <h4>After · {isPack ? 'installed pack' : 'included compiler'}</h4>
              <p className="settings-hint">
                Tectonic {to?.version} · {to?.bundle}
              </p>
              <PdfPreview data={comparison.after} building={false} stale={false} status={null} />
            </section>
          </div>
        </>
      ) : (
        <div className="compiler-comparison-intro">
          <p>
            Folio will build your resume with the recorded compiler and{' '}
            {isPack ? 'the selected installed pack' : 'this app’s included compiler'}, then show the
            results together.
          </p>
          <dl>
            <dt>Recorded compiler</dt>
            <dd>
              Tectonic {from?.version} · {from?.bundle}
            </dd>
            <dt>{isPack ? 'Selected pack' : 'Included compiler'}</dt>
            <dd>
              Tectonic {to?.version} · {to?.bundle}
            </dd>
          </dl>
          <p>
            Your compiler choice stays the same until you select{' '}
            <strong>{isPack ? 'Use this pack' : 'Use included compiler'}</strong>. A local backup
            will keep your source, assets, history and the comparison PDFs.
          </p>
          {working && <p role="status">Building the comparison and saving your backup…</p>}
        </div>
      )}
      {error && (
        <p role="alert" className="error-text">
          {error}
        </p>
      )}
      <div className="modal-actions">
        {comparison && (
          <button
            className="button secondary"
            disabled={applying}
            onClick={() => void onShowBackup(comparison.id).catch((e) => setError(e.message))}
          >
            Show backup
          </button>
        )}
        <button className="button secondary" disabled={applying} onClick={onClose}>
          {working ? 'Stop comparison' : 'Keep recorded compiler'}
        </button>
        {comparison ? (
          <button
            className="button primary"
            disabled={applying}
            onClick={() => {
              setApplying(true);
              setError('');
              void onApply(comparison)
                .catch((e) => setError(e.message))
                .finally(() => setApplying(false));
            }}
          >
            {applying ? 'Applying…' : isPack ? 'Use this pack' : 'Use included compiler'}
          </button>
        ) : (
          <button
            className="button primary"
            disabled={working}
            onClick={() => {
              setWorking(true);
              setError('');
              void onPrepare()
                .then(setComparison)
                .catch((e) => setError(e.message))
                .finally(() => setWorking(false));
            }}
          >
            {working ? 'Building…' : 'Build comparison'}
          </button>
        )}
      </div>
    </Modal>
  );
}
