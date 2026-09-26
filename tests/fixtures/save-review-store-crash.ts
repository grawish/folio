import { SaveTransactions } from '../../electron/core/save-transactions';
import { ProjectStore } from '../../electron/core/project';
import { WorkspaceStore } from '../../electron/core/workspace';
const [data, stage] = process.argv.slice(2);
async function stop() {
  process.stdout.write('READY-TO-KILL\n');
  await new Promise(() => setInterval(() => {}, 60_000));
}
const transaction = new SaveTransactions(data, {
  afterResolutionPrepared: async () => {
    if (stage === 'prepared') await stop();
  },
  afterResolutionApply: async (index) => {
    if (stage === 'applying' && index === 0) await stop();
  },
  afterResolutionCommit: async () => {
    if (stage === 'completed') await stop();
  },
  afterResolutionArchive: async () => {
    if (stage === 'archived') await stop();
  },
});
const store = new ProjectStore(data, transaction),
  workspace = new WorkspaceStore(data);
const item = (await store.interruptedSaves())[0];
const review = (await store.reviewSave(item.id))!;
await store.resolveSave(
  item.id,
  review.token,
  review.files.map((file) => ({ path: file.path, version: 'before' })),
  (id) => workspace.archive(id),
);
