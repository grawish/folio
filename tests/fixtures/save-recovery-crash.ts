import { SaveTransactions } from '../../electron/core/save-transactions';
const [data, root, stage] = process.argv.slice(2);
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
const review = (await transaction.review(root))!;
await transaction.resolve(
  root,
  review.token,
  review.files.map((file) => ({ path: file.path, version: 'before' })),
);
