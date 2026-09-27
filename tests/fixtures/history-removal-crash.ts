import { WorkspaceStore } from '../../electron/core/workspace';
const [root, version, stage] = process.argv.slice(2);
const wait = async () => {
  process.stdout.write('READY-TO-KILL\n');
  await new Promise(() => {
    setInterval(() => {}, 60_000);
  });
};
const store = new WorkspaceStore(root, {
  afterApply: async (index) => {
    if (stage === `apply-${index}`) await wait();
  },
  afterCommit: async () => {
    if (stage === 'committed') await wait();
  },
});
await store.removeVersion('resume', version);
