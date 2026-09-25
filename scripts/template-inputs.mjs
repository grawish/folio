import { promises as fs } from 'node:fs';
import path from 'node:path';
import { tsImport } from 'tsx/esm/api';

// Share the exact paper transformation with project creation and corpus tests.
const { templateCatalog, paperSizes, templateSource } = await tsImport(
  '../src/shared/template-catalog.ts',
  import.meta.url,
);
export async function templateInputs(destination) {
  await fs.mkdir(destination, { recursive: true });
  const result = [];
  for (const template of templateCatalog) {
    const source = await fs.readFile(`resources/templates/${template.id}.tex`, 'utf8');
    for (const paper of paperSizes) {
      const filename = path.resolve(destination, `${template.id}-${paper.id}.tex`);
      await fs.writeFile(filename, templateSource(source, paper.id));
      result.push(filename);
    }
  }
  return result;
}
