import { promises as fs } from 'node:fs';
import path from 'node:path';
import { ProjectImporter } from '../../electron/core/project-import';
import { writeImportFile } from '../../electron/core/import-transactions';

const [dataRoot, parent, archive, stage] = process.argv.slice(2);
async function stop(boundary: string) {
  if (stage !== boundary) return;
  process.stdout.write('READY-TO-KILL\n');
  await new Promise(() => setInterval(() => {}, 1000));
}
let writes = 0;
const importer = new ProjectImporter(
  dataRoot,
  async (filename, data) => {
    if (stage === 'partial' && writes++ === 0) {
      await writeImportFile(filename, data.subarray(0, Math.max(1, Math.floor(data.length / 2))));
      await stop('partial');
    }
    await writeImportFile(filename, data);
  },
  {
    afterStageFile: async (index) => {
      if (index === 0) await stop('staging');
    },
    afterPrepare: () => stop('prepared'),
    afterDirectory: () => stop('directory'),
    afterWrite: async (index) => {
      if (index === 0) await stop('file');
    },
    afterComplete: () => stop('complete'),
    afterDiscard: () => stop('discarded'),
  },
);
const preview = await importer.prepare(archive);
await importer.finish(preview.token, 'main.tex', parent);
if (stage === 'discarded')
  await importer.discard(preview.token, (directory) =>
    fs.rename(directory, path.join(parent, 'test-trash')),
  );
throw new Error('Crash fixture did not reach ' + stage);
