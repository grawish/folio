import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { ProjectStore } from '../electron/core/project';

const [data, folder] = process.argv.slice(2);
if (!data || !folder) throw new Error('Provide app-data and project directories.');

const original = 'Original source\n' + 'A'.repeat(1_500_000);
const changed = 'Changed source after low space\n' + 'B'.repeat(1_500_000);
await fs.mkdir(folder, { recursive: true });
await fs.writeFile(path.join(folder, 'main.tex'), original);

const store = new ProjectStore(data);
const project = await store.open(folder);
await store.save(project, undefined, false, async () => Buffer.alloc(1_500_000, 0x61));
const next = {
  ...project,
  revision: project.revision + 1,
  files: project.files.map((file) => ({ ...file, content: changed })),
};

const fillerPath = path.join(folder, 'filler');
const filler = await fs.open(fillerPath, 'w');
let fillerError: string | undefined;
try {
  const block = Buffer.alloc(1024 * 1024, 0x7a);
  for (;;) await filler.write(block);
} catch (error) {
  fillerError = (error as NodeJS.ErrnoException).code;
} finally {
  await filler.close();
}
assert.equal(fillerError, 'ENOSPC');

let saveError = '';
try {
  await store.save(next, undefined, false, async () => Buffer.alloc(1_500_000, 0x62));
} catch (error) {
  saveError = String(error);
}
assert.match(saveError, /ENOSPC|no space/i);
assert.equal(await fs.readFile(path.join(folder, 'main.tex'), 'utf8'), original);

await fs.rm(fillerPath);
await store.save(next, undefined, false, async () => Buffer.alloc(1_500_000, 0x62));
assert.equal(await fs.readFile(path.join(folder, 'main.tex'), 'utf8'), changed);

console.log(
  JSON.stringify({
    passed: true,
    fillerError,
    saveError: saveError.replaceAll(/\b\/Volumes\/[^\s]+/g, '<test-volume>'),
  }),
);
