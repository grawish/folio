import { RuntimeManager } from '../../electron/core/runtime-manager';
const [bundle, data, boundary] = process.argv.slice(2);
const manager = new RuntimeManager(bundle, data, {
  probe: async () => {},
  checkpoint: async (phase) => {
    if (phase === boundary) {
      console.log('READY-TO-KILL');
      await new Promise(() => {});
    }
  },
});
await manager.initialize();
await manager.repair();
