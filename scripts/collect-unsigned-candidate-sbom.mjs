import { tsImport } from 'tsx/esm/api';

if (process.platform !== 'darwin' || !process.argv[2])
  throw new Error('Provide a packaged Folio.app directory on macOS.');
const { collectUnsignedCandidateMaterials } = await tsImport(
  './collect-unsigned-candidate-sbom.ts',
  import.meta.url,
);
const report = await collectUnsignedCandidateMaterials(process.argv[2]);
console.log(JSON.stringify(report, null, 2));
