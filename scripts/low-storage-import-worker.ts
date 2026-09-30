import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ImportTransactions } from '../electron/core/import-transactions';

const [data, parent] = process.argv.slice(2);
if (!data || !parent) throw new Error('Provide app-data and import-parent directories.');

const source = Buffer.from(
  '\\documentclass{article}\n\\begin{document}\nLow-space import\n\\end{document}\n',
);
const asset = Buffer.alloc(1_500_000, 0x61);
const files = new Map([
  ['main.tex', source],
  ['assets/large.bin', asset],
]);
const fillerPath = path.join(parent, 'filler');
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

const imports = new ImportTransactions(data);
let importError = '';
try {
  await imports.create(randomUUID(), 'Low storage import', 'main.tex', parent, files);
} catch (error) {
  importError = String(error);
}
assert.match(importError, /needs about .* MB free in Folio storage/);
assert.deepEqual(await fs.readdir(path.join(data, 'import-transactions')), []);
assert.deepEqual((await fs.readdir(parent)).sort(), ['filler']);

await fs.rm(fillerPath);
const id = randomUUID();
await imports.create(id, 'Low storage import', 'main.tex', parent, files);
const result = await imports.resume(id);
assert.deepEqual(await fs.readFile(path.join(result.directory, 'main.tex')), source);
assert.deepEqual(await fs.readFile(path.join(result.directory, 'assets/large.bin')), asset);
await imports.acknowledge(id);
console.log(
  JSON.stringify({
    passed: true,
    fillerError,
    importError: importError.replaceAll(/\b\/Volumes\/[^\s]+/g, '<test-volume>'),
  }),
);
