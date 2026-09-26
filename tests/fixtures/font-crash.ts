import { ProjectStore } from '../../electron/core/project';
import { SaveTransactions } from '../../electron/core/save-transactions';
const [data, folder, stage] = process.argv.slice(2);
const stop = async () => {
  process.stdout.write('READY-TO-KILL\n');
  await new Promise(() => {
    setInterval(() => {}, 60_000);
  });
};
const store = new ProjectStore(
  data,
  new SaveTransactions(data, {
    afterApply: async (index) => {
      if (stage === 'applying' && index === 2) await stop();
    },
    afterCommit: async () => {
      if (stage === 'committed') await stop();
    },
  }),
);
const project = await store.open(folder);
const next = {
  ...project,
  revision: project.revision + 1,
  files: [
    { path: 'main.tex', content: project.files[0].content + '\n% FONT-SAVE-COMMITTED' },
    { path: 'fonts/setup.tex', content: '% Added with font bytes' },
  ],
};
await store.saveWithAssets(next, new Map([['fonts/fixture.otf', Buffer.from([0, 1, 2, 255])]]));
