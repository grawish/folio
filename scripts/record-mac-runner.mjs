import { promises as fs } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const expectedMajors = { 'macos-14': 14, 'macos-15': 15, 'macos-26': 26, 'xcode-27': 27 };
const [selectedRunner, output = 'test-results/runner-environment.json'] = process.argv.slice(2);
const record = {
  schemaVersion: 1,
  recordedAt: new Date().toISOString(),
  passed: false,
  requestedRunner: selectedRunner ?? null,
  githubActions: process.env.GITHUB_ACTIONS === 'true',
  scope:
    'OS and hardware identity of this qualification host. Hosted developer images are not clean consumer installations or physical display/accessibility acceptance.',
};
await fs.mkdir(path.dirname(output), { recursive: true });
await fs.writeFile(output, JSON.stringify(record, null, 2) + '\n');
const command = (file, args) => execFileSync(file, args, { encoding: 'utf8' }).trim();
try {
  if (!Object.hasOwn(expectedMajors, selectedRunner)) throw new Error('Unknown Mac runner choice.');
  if (process.platform !== 'darwin' || process.arch !== 'arm64')
    throw new Error('Qualification requires native Apple silicon Node.js.');
  const architecture = command('/usr/bin/uname', ['-m']);
  const productVersion = command('/usr/bin/sw_vers', ['-productVersion']);
  const productBuild = command('/usr/bin/sw_vers', ['-buildVersion']);
  const kernelRelease = command('/usr/bin/uname', ['-r']);
  const expectedMajor = expectedMajors[selectedRunner];
  record.operatingSystem = {
    productVersion,
    productBuild,
    kernelRelease,
    architecture,
    expectedMajor,
  };
  if (architecture !== 'arm64' || Number(productVersion.split('.')[0]) !== expectedMajor)
    throw new Error(
      'The actual architecture or macOS major version differs from the selected image.',
    );
  const sourceCommit = command('/usr/bin/git', ['rev-parse', 'HEAD']);
  if (
    !/^[a-f0-9]{40}$/.test(sourceCommit) ||
    (record.githubActions && process.env.GITHUB_SHA !== sourceCommit)
  )
    throw new Error('The checked-out source differs from the workflow commit.');
  record.sourceCommit = sourceCommit;
  record.scriptSha256 = createHash('sha256')
    .update(await fs.readFile(fileURLToPath(import.meta.url)))
    .digest('hex');
  record.hardware = {
    model: command('/usr/sbin/sysctl', ['-n', 'hw.model']),
    logicalCpus: Number(command('/usr/sbin/sysctl', ['-n', 'hw.logicalcpu'])),
    memoryBytes: Number(command('/usr/sbin/sysctl', ['-n', 'hw.memsize'])),
  };
  record.nodeVersion = process.version;
  if (record.githubActions) {
    record.github = {
      runId: process.env.GITHUB_RUN_ID,
      attempt: process.env.GITHUB_RUN_ATTEMPT,
      imageOS: process.env.ImageOS ?? null,
      imageVersion: process.env.ImageVersion ?? null,
    };
  }
  record.passed = true;
  console.log(
    `Verified native ${architecture}, macOS ${productVersion} (${productBuild}), for ${selectedRunner}.`,
  );
} catch (error) {
  record.error = error.message;
  throw error;
} finally {
  await fs.writeFile(output, JSON.stringify(record, null, 2) + '\n');
}
