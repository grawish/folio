import { promises as fs } from 'node:fs';
import path from 'node:path';
import { ProjectStore } from '../../electron/core/project';
import { WorkspaceStore } from '../../electron/core/workspace';
import { SaveTransactions, fileDigest } from '../../electron/core/save-transactions';

const [dataRoot, folder, config, stage] = process.argv.slice(2);
const { pin } = JSON.parse(await fs.readFile(config, 'utf8'));
const pause = async () => {
  process.stdout.write('READY-TO-KILL\n');
  await new Promise(() => {
    setInterval(() => {}, 60_000);
  });
};
const transaction = new SaveTransactions(dataRoot, {
  afterApply: async (index) => {
    const journal = JSON.parse(
      await fs.readFile(
        path.join(dataRoot, 'save-transactions', fileDigest(folder), 'journal.json'),
        'utf8',
      ),
    );
    if (journal.entries[index].path === stage) await pause();
  },
  afterCommit: async () => {
    if (stage === 'committed') await pause();
  },
  afterRollback: async () => {
    if (stage === 'rollback') await pause();
  },
});
const store = new ProjectStore(dataRoot, transaction, () => pin);
const project = await store.open(folder);
project.revision++;
project.files = project.files.map((file) => ({
  ...file,
  content: file.content + '\n% Upgraded edit',
}));
const workspace = new WorkspaceStore(dataRoot);
await workspace.checkpoint(project, Buffer.from('%PDF-1.4\nUpdated storage fixture'), 'Updated');
const result = await store.save(project, undefined, false, (id) => workspace.archive(id));
if (result.conflict) throw new Error('Unexpected schema upgrade conflict');
