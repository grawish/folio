import catalog from '../../resources/templates/catalog.json';
import type { TemplateId } from './types';

export type PaperSize = 'a4' | 'letter';
export type TemplateDefinition = {
  id: TemplateId;
  version: number;
  name: string;
  label: string;
  description: string;
  font: string;
  bodySize: number;
  sampleName: string;
  email: string;
  sections: string[];
  checks: string[];
  note: string;
};
export const templateCatalog = catalog as readonly TemplateDefinition[];
export const paperSizes = [
  {
    id: 'a4' as const,
    label: 'A4 · 210 × 297 mm',
    option: 'a4paper',
    width: 595.276,
    height: 841.89,
  },
  {
    id: 'letter' as const,
    label: 'US Letter · 8.5 × 11 in',
    option: 'letterpaper',
    width: 612,
    height: 792,
  },
];

// Only trusted bundled templates use this transformation. Imported and edited
// projects keep their source as the authority for paper geometry.
export function templateSource(source: string, paper: PaperSize): string {
  const size = paperSizes.find((entry) => entry.id === paper);
  if (!size) throw new Error('Choose A4 or US Letter.');
  const pattern = /^\\documentclass\[([^\]\n]+)\]\{article\}/m;
  if (!pattern.test(source)) throw new Error('The template has no supported paper setting.');
  return source.replace(pattern, (_match, options: string) => {
    const entries = options.split(',').map((value) => value.trim());
    if (entries.filter((value) => /^(a4|letter)paper$/.test(value)).length !== 1)
      throw new Error('The template must declare one paper size.');
    return `\\documentclass[${entries.map((value) => (/^(a4|letter)paper$/.test(value) ? size.option : value)).join(',')}]{article}`;
  });
}
