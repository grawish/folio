import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs, createWriteStream } from 'node:fs';
import path from 'node:path';
import { finished } from 'node:stream/promises';
import { macReleaseSuites } from './mac-release-suites.mjs';

const release = path.resolve(process.argv[2] ?? 'release/import-recovery');
const executable = path.join(release, 'mac-arm64/Folio.app/Contents/MacOS/Folio');
const asar = path.join(release, 'mac-arm64/Folio.app/Contents/Resources/app.asar');
const hash = async (file) =>
  createHash('sha256')
    .update(await fs.readFile(file))
    .digest('hex');
const original = await hash(asar);
const suites = macReleaseSuites;
const qualificationEnv = { ...process.env };
// Qualification must exercise preparation from a fresh profile, even if an
// iteration-only runtime seed was set in the invoking shell.
delete qualificationEnv.FOLIO_TEST_RUNTIME_SEED;
const resultFile = path.join(release, 'native-tests.json');
let previous;
try {
  previous = JSON.parse(await fs.readFile(resultFile, 'utf8'));
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
const completed = [];
if (process.argv.includes('--resume')) {
  if (!previous || previous.asarSha256 !== original || previous.executable !== executable)
    throw new Error('Resume requires a previous run against this exact app.');
  for (const [index, result] of previous.suites.entries()) {
    if (!result.passed) break;
    if (
      result.suite !== suites[index] ||
      result.code !== 0 ||
      result.unchanged !== true ||
      result.scriptSha256 !== (await hash(`scripts/test-${suites[index]}.mjs`))
    )
      throw new Error('A completed suite changed. Start a new qualification run.');
    const log = await fs.readFile(result.log, 'utf8');
    if (!result.evidence || !log.includes(`Evidence: ${result.evidence}`))
      throw new Error('The completed suite evidence is missing. Start a new run.');
    await fs.access(result.evidence);
    completed.push(result);
  }
}
const run = {
  startedAt: new Date().toISOString(),
  executable,
  asarSha256: original,
  suites: completed,
  passed: false,
};
await fs.mkdir('test-results', { recursive: true });
// Keep failed results and logs reviewable instead of erasing the failed attempt.
if (previous) {
  const archive = path.resolve(
    'test-results',
    `${path.basename(release)}-qualification-${Date.now()}`,
  );
  await fs.mkdir(archive);
  await fs.writeFile(path.join(archive, 'native-tests.json'), JSON.stringify(previous, null, 2));
  for (const result of previous.suites)
    await fs.copyFile(result.log, path.join(archive, path.basename(result.log)));
}
try {
  // Native windows must run sequentially: competing windows change keyboard
  // focus and make pointer-driven tests unreliable.
  for (const result of completed) console.log(`REUSED: ${result.suite} (${result.evidence})`);
  for (const suite of suites.slice(completed.length)) {
    const script = `scripts/test-${suite}.mjs`;
    const scriptHash = await hash(script);
    const logFile = path.resolve('test-results', `${path.basename(release)}-${suite}-final.log`);
    const log = createWriteStream(logFile, { flags: 'w', mode: 0o600 });
    const child = spawn(process.execPath, ['--import', 'tsx', script, executable], {
      env: qualificationEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.pipe(log, { end: false });
    child.stderr.pipe(log, { end: false });
    const completion = await new Promise((resolve, reject) => {
      child.on('error', reject);
      child.on('close', (code, signal) => resolve({ code, signal }));
    }).finally(async () => {
      log.end();
      await finished(log);
    });
    const unchanged = (await hash(asar)) === original && (await hash(script)) === scriptHash;
    const text = await fs.readFile(logFile, 'utf8');
    const evidence = text.match(/^Evidence: (.+)$/m)?.[1];
    const result = {
      suite,
      script,
      scriptSha256: scriptHash,
      log: logFile,
      evidence,
      ...completion,
      unchanged,
      passed: completion.code === 0 && unchanged && !!evidence,
    };
    run.suites.push(result);
    await fs.writeFile(resultFile, JSON.stringify(run, null, 2) + '\n');
    if (!result.passed) throw new Error(`${suite} failed; inspect ${logFile}`);
    console.log(`PASS: ${suite} (${evidence})`);
  }
  run.passed = true;
} finally {
  run.finishedAt = new Date().toISOString();
  await fs.writeFile(resultFile, JSON.stringify(run, null, 2) + '\n');
}
