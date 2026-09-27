import { promises as fs } from 'node:fs';
import { PreferenceStore } from '../../electron/core/preferences';
import { defaultPreferences } from '../../src/shared/preferences';
const [root, boundary] = process.argv.slice(2);
const store = new PreferenceStore(root);
await store.initialize(defaultPreferences);
const hold = async () => {
  console.log('READY-TO-KILL');
  await new Promise(() => setInterval(() => {}, 60_000));
};
const rename = fs.rename.bind(fs);
fs.rename = async (from, to) => {
  if (to === store.filename && boundary === 'before-commit') await hold();
  await rename(from, to);
  if (to === store.filename && boundary === 'after-commit') await hold();
};
await store.update({ 'folio:auto': 'false', 'folio:appearance': 'light', 'folio:font': '18' });
if (boundary === 'acknowledged') await hold();
