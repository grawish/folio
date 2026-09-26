import { useRef, useState } from 'react';
import { Modal } from './Modal';
import { PdfPreview, type PdfPreviewHandle } from './PdfPreview';
import {
  fontStyles,
  type FontPreview,
  type FontStyle,
  type FontTarget,
  type SelectedFont,
} from '../shared/fonts';
import { errorMessage } from '../error-message';

const labels: Record<FontStyle, string> = {
  regular: 'Regular',
  bold: 'Bold',
  italic: 'Italic',
  boldItalic: 'Bold italic',
};

export function FontSetup({
  saved,
  onSaveProject,
  onChoose,
  onRemove,
  onPreview,
  onApply,
  onClose,
}: {
  saved: boolean;
  onSaveProject(): Promise<boolean>;
  onChoose(style: FontStyle): Promise<SelectedFont | null>;
  onRemove(style: FontStyle): Promise<void>;
  onPreview(target: FontTarget): Promise<FontPreview>;
  onApply(): Promise<void>;
  onClose(): void;
}) {
  const [selected, setSelected] = useState<Partial<Record<FontStyle, SelectedFont>>>({});
  const [preview, setPreview] = useState<FontPreview>();
  const [working, setWorking] = useState('');
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState('');
  const pdf = useRef<PdfPreviewHandle>(null);
  const run = async (label: string, action: () => Promise<void>) => {
    setWorking(label);
    setError('');
    try {
      await action();
    } catch (error) {
      setError(errorMessage((error as Error).message));
    } finally {
      setWorking('');
    }
  };
  return (
    <Modal
      wide
      className="font-setup"
      title="Add local fonts"
      description="Choose your font files and review the resume before saving."
      onClose={onClose}
      dismissible={!applying}
    >
      {!saved ? (
        <div className="font-start">
          <p>
            Save your resume in a project folder first. Folio will keep its font files in that
            folder, so they travel with the project.
          </p>
          <button
            className="button primary"
            disabled={!!working}
            onClick={() =>
              void run('Saving the project…', async () => {
                await onSaveProject();
              })
            }
          >
            Save project to continue
          </button>
        </div>
      ) : (
        <div className="font-setup-content">
          <fieldset className="font-options" disabled={!!working || applying}>
            <strong>Body text and headings</strong>
            <p className="settings-hint">
              Some templates use their own font choices. Check the full preview before saving.
            </p>
            {fontStyles.map((style) => (
              <div className="font-choice" key={style}>
                <strong>
                  {labels[style]}
                  {style === 'regular' ? ' · required' : ''}
                </strong>
                <span>{selected[style]?.name ?? 'No file selected'}</span>
                <div>
                  <button
                    className="button secondary"
                    aria-label={`Choose ${labels[style].toLowerCase()} font`}
                    onClick={() =>
                      void run('Choosing a font…', async () => {
                        const font = await onChoose(style);
                        if (font) {
                          setSelected((previous) => ({ ...previous, [style]: font }));
                          setPreview(undefined);
                        }
                      })
                    }
                  >
                    {selected[style] ? 'Change file' : 'Choose file'}
                  </button>
                  {selected[style] && (
                    <button
                      className="text-button"
                      aria-label={`Remove ${labels[style].toLowerCase()} font`}
                      onClick={() =>
                        void run('Removing the selection…', async () => {
                          await onRemove(style);
                          setSelected((previous) => ({ ...previous, [style]: undefined }));
                          setPreview(undefined);
                        })
                      }
                    >
                      Remove
                    </button>
                  )}
                </div>
              </div>
            ))}
            <p className="settings-hint">
              Choose OTF or TTF files, up to 20 MB together. Unselected styles use the regular font.
              Font files are copied into this project.
            </p>
          </fieldset>
          <section className="font-preview" aria-label="Font preview">
            {preview ? (
              <PdfPreview
                ref={pdf}
                data={preview.pdf}
                building={false}
                stale={false}
                status={<span>Preview · not saved yet</span>}
              />
            ) : (
              <div className="font-preview-empty">
                <strong>See your resume with these fonts</strong>
                <p>
                  Choose a regular font, then build a preview. Your current resume stays as it is
                  until you save the change.
                </p>
              </div>
            )}
          </section>
        </div>
      )}
      {working && (
        <p role="status" className="settings-hint">
          {working}
        </p>
      )}
      {error && (
        <p role="alert" className="font-error error-text">
          {error}
        </p>
      )}
      <div className="modal-actions">
        <button className="button secondary" disabled={applying} onClick={onClose}>
          {working ? 'Stop and close' : 'Cancel'}
        </button>
        {saved &&
          (preview ? (
            <button
              className="button primary"
              disabled={applying || !!working}
              onClick={() => {
                setApplying(true);
                void run('Saving fonts and source…', async () => {
                  if (!pdf.current) throw new Error('Wait for the font preview to load.');
                  await pdf.current.waitForPdf(preview.pdf);
                  await onApply();
                }).finally(() => setApplying(false));
              }}
            >
              {applying ? 'Saving…' : 'Use fonts & save'}
            </button>
          ) : (
            <button
              className="button primary"
              disabled={!selected.regular || !!working}
              onClick={() =>
                void run('Building the font preview…', async () => {
                  setPreview(await onPreview('body'));
                })
              }
            >
              Build font preview
            </button>
          ))}
      </div>
    </Modal>
  );
}
