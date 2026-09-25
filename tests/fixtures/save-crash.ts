import { promises as fs } from 'node:fs';
import { SaveTransactions, readTarget } from '../../electron/core/save-transactions';
const [dataRoot, root, inputFile, stage] = process.argv.slice(2);
const waitToBeKilled = async () => {
  process.stdout.write('READY-TO-KILL\n');
  // Keep the process alive at an exact journal boundary until the parent kills it.
  await new Promise(() => {
    setInterval(() => {}, 60_000);
  });
};
const changes: Array<{ path: string; content: string | null }> = JSON.parse(
  await fs.readFile(inputFile, 'utf8'),
);
const transaction = new SaveTransactions(dataRoot, {
  afterApply: async (index) => {
    if (stage === 'applying' && index === 1) await waitToBeKilled();
  },
  afterCommit: async () => {
    if (stage === 'committed') await waitToBeKilled();
  },
  afterRollback: async () => {
    if (stage === 'rollback') await waitToBeKilled();
  },
});
await transaction.commit(
  root,
  await Promise.all(
    changes.map(async (entry) => ({
      path: entry.path,
      data: entry.content === null ? null : Buffer.from(entry.content),
      before: await readTarget(root, entry.path),
    })),
  ),
);
