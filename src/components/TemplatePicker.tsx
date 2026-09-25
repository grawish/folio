import { useState } from 'react';
import { ArrowRight, ShieldCheck } from 'lucide-react';
import { Modal } from './Modal';
import { templateCatalog, paperSizes, type PaperSize } from '../shared/template-catalog';
import type { TemplateId } from '../shared/types';

export function TemplatePicker({
  onSelect,
  onClose,
}: {
  onSelect(id: TemplateId, paper: PaperSize): void;
  onClose(): void;
}) {
  const [paper, setPaper] = useState<PaperSize>('a4');
  return (
    <Modal
      wide
      className="template-picker"
      title="Choose your starting point"
      description="Six layouts with sample content. Choose a paper size, then a template."
      onClose={onClose}
    >
      <div className="template-options">
        <label htmlFor="template-paper">Paper size</label>
        <select
          id="template-paper"
          className="text-input"
          value={paper}
          onChange={(event) => setPaper(event.target.value as PaperSize)}
        >
          {paperSizes.map((size) => (
            <option key={size.id} value={size.id}>
              {size.label}
            </option>
          ))}
        </select>
        <span>All layouts support A4 and US Letter.</span>
      </div>
      <div className="template-grid">
        {templateCatalog.map((template) => (
          <button
            key={template.id}
            className="template-card"
            aria-label={`Create ${template.name} resume`}
            onClick={() => onSelect(template.id, paper)}
          >
            <div className="template-thumbnail">
              <img src={`./templates/${template.id}-${paper}.png`} alt="" loading="lazy" />
            </div>
            <div className="template-meta">
              <span>{template.label}</span>
              <h3>
                {template.name}
                <ArrowRight size={16} />
              </h3>
              <p>{template.description}</p>
              <p className="template-font">
                {template.font} · {template.bodySize} pt · bundled
              </p>
              <p className="template-note">{template.note}</p>
            </div>
          </button>
        ))}
      </div>
      <p className="modal-footnote">
        <ShieldCheck size={14} />
        Previews show the actual sample PDFs. Every layout builds offline. Replace sample facts with
        your own; you can change the paper setting in Code later.
      </p>
    </Modal>
  );
}
