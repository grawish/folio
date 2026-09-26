import { promises as fs } from 'node:fs';
import { RuntimeManager } from '../../electron/core/runtime-manager';
import { ResourcePackVerifier } from '../../electron/core/resource-pack';
const [base, data, archive, publicKey, boundary] = process.argv.slice(2);
const pack = new ResourcePackVerifier({ fixture: await fs.readFile(publicKey, 'utf8') }).read(
  await fs.readFile(archive),
);
const manager = new RuntimeManager(base, data, {
  probe: async () => {},
  checkpoint: async (phase) => {
    if (phase === boundary) {
      console.log('READY-TO-KILL');
      await new Promise(() => setInterval(() => {}, 60_000));
    }
  },
});
await manager.installPack(pack);
