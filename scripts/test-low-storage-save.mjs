import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import path from 'node:path';

if (process.platform !== 'darwin' || process.arch !== 'arm64')
  throw new Error('This APFS low-storage control requires an Apple silicon Mac.');

const root = await fs.mkdtemp(path.resolve('test-results/low-storage-save-'));
const image = path.join(root, 'low-storage.sparsebundle');
const volume = 'FolioLowStorage';
let mount;
try {
  execFileSync(
    '/usr/bin/hdiutil',
    ['create', '-size', '64m', '-type', 'SPARSEBUNDLE', '-fs', 'APFS', '-volname', volume, image],
    { stdio: 'pipe' },
  );
  const attached = execFileSync('/usr/bin/hdiutil', ['attach', '-nobrowse', image], {
    encoding: 'utf8',
  });
  mount = attached
    .split('\n')
    .map((line) => line.trim().split(/\s+/).at(-1))
    .find((entry) => entry === `/Volumes/${volume}`);
  assert.ok(mount, 'The APFS sparse image did not mount at its expected volume path.');
  const data = path.join(mount, 'data');
  const project = path.join(mount, 'project');
  await fs.mkdir(data);
  await fs.mkdir(project);
  const run = async (worker, args) => {
    const child = spawn(process.execPath, ['--import', 'tsx', worker, ...args], {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '',
      stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    const code = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });
    assert.equal(code, 0, stderr);
    return JSON.parse(stdout);
  };
  const result = await run('scripts/low-storage-save-worker.ts', [data, project]);
  assert.equal(result.passed, true);
  assert.equal(result.fillerError, 'ENOSPC');
  assert.match(result.saveError, /ENOSPC|no space/i);
  const importData = path.join(mount, 'import-data');
  const imports = path.join(mount, 'imports');
  await fs.mkdir(importData);
  await fs.mkdir(imports);
  const importResult = await run('scripts/low-storage-import-worker.ts', [importData, imports]);
  assert.equal(importResult.passed, true);
  assert.equal(importResult.fillerError, 'ENOSPC');
  assert.match(importResult.importError, /needs about .* MB free in Folio storage/);
  await fs.writeFile(
    path.join(root, 'result.json'),
    JSON.stringify(
      {
        schemaVersion: 1,
        passed: true,
        filesystem: 'APFS sparsebundle',
        volumeBytes: 64 * 1024 * 1024,
        save: {
          fillerError: result.fillerError,
          error: result.saveError,
        },
        import: {
          fillerError: importResult.fillerError,
          error: importResult.importError,
        },
        scope:
          'Real APFS ENOSPC events during journaled save and staged import preserve original/destination bytes, then succeed after space is freed. This does not establish power-loss or network-filesystem behavior.',
      },
      null,
      2,
    ) + '\n',
  );
  console.log(
    'PASS: journaled save and staged import reject real APFS ENOSPC without changing source or destination, then succeed after space is freed.',
  );
  console.log(`Evidence: ${root}`);
} finally {
  if (mount) execFileSync('/usr/bin/hdiutil', ['detach', mount], { stdio: 'ignore' });
  await fs.rm(image, { recursive: true, force: true });
}
