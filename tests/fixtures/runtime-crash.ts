import { RuntimeManager } from '../../electron/core/runtime-manager';
const [bundle, data, boundary] = process.argv.slice(2);
const manager = new RuntimeManager(bundle, data, {
  probe: async () => {},
  checkpoint: async (phase) => {
    if (phase === boundary) {
      console.log('READY-TO-KILL');
      // An unresolved promise alone does not keep Node's event loop alive.
      await new Promise(() => setInterval(() => {}, 60_000));
    }
  },
});
await manager.initialize();
await manager.repair();
