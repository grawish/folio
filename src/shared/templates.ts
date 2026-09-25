import classic from '../../resources/templates/classic.tex?raw';
import modern from '../../resources/templates/modern.tex?raw';
import academic from '../../resources/templates/academic.tex?raw';
import minimal from '../../resources/templates/minimal.tex?raw';
import compactTechnical from '../../resources/templates/compact-technical.tex?raw';
import twoColumn from '../../resources/templates/two-column.tex?raw';
import type { Project, TemplateId } from './types';
import { templateCatalog, templateSource, type PaperSize } from './template-catalog';

const sources = {
  classic,
  modern,
  academic,
  minimal,
  'compact-technical': compactTechnical,
  'two-column': twoColumn,
};
export const templates = templateCatalog.map((template) => ({
  ...template,
  source: sources[template.id],
}));

export function createProject(id: TemplateId = 'classic', paper: PaperSize = 'a4'): Project {
  const template = templates.find((t) => t.id === id) ?? templates[0];
  return {
    id: crypto.randomUUID(),
    name: 'My resume',
    mainFile: 'main.tex',
    files: [{ path: 'main.tex', content: templateSource(template.source, paper) }],
    templateId: template.id,
    templateVersion: template.version,
    revision: 0,
  };
}
