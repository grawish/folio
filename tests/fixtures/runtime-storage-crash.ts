import { promises as fs } from 'node:fs';
import { RuntimeManager } from '../../electron/core/runtime-manager';
const [bundle, data, key] = process.argv.slice(2);
const manager = new RuntimeManager(bundle, data, { probe: async () => {} });
const entry = (await manager.storage()).entries.find((entry) => entry.key === key)!;
const unlink = fs.unlink.bind(fs);
fs.unlink = async (name) => {
  await unlink(name);
  if (String(name).includes('/removing-')) {
    console.log('READY-TO-KILL');
    await new Promise(() => setInterval(() => {}, 60_000));
  }
};
await manager.removeStoredCompiler(key, entry.token);
