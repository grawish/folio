import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { unzipSync, strFromU8 } from 'fflate';

const fixture = {
  'alpha.tex': '\\documentclass{article}\n',
  'zeta.sty': '% Original resource bytes\r\n',
  SHA256SUM: 'a'.repeat(64),
};
function bundle(timezone: string, files = fixture) {
  const result = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import { createRuntimeBundle } from './scripts/lib/runtime-bundle.mjs';
       import { strToU8 } from 'fflate';
       const files = JSON.parse(process.argv[1]);
       process.stdout.write(createRuntimeBundle(Object.fromEntries(
         Object.entries(files).map(([name, text]) => [name, strToU8(text)]))));`,
      JSON.stringify(files),
    ],
    { env: { ...process.env, TZ: timezone }, timeout: 10_000, maxBuffer: 1024 * 1024 },
  );
  assert.equal(
    result.status,
    0,
    result.stderr?.toString() || result.error?.message || 'Bundle subprocess failed',
  );
  return result.stdout;
}

test('runtime bundle preserves published ZIP clock fields in every build timezone', () => {
  const publishedZone = bundle('Asia/Kolkata');
  // The first published core bundle uses these DOS clock fields. They describe
  // ZIP metadata, not an instant to convert into the builder's local timezone.
  assert.equal(publishedZone.readUInt16LE(10), (5 << 11) | (30 << 5));
  assert.equal(publishedZone.readUInt16LE(12), (44 << 9) | (1 << 5) | 1);
  for (const timezone of ['UTC', 'America/Los_Angeles', 'Pacific/Auckland'])
    assert.deepEqual(bundle(timezone), publishedZone, `Bundle bytes changed in ${timezone}`);
  const files = unzipSync(publishedZone);
  assert.deepEqual(Object.keys(files), Object.keys(fixture));
  for (const [name, text] of Object.entries(fixture)) assert.equal(strFromU8(files[name]), text);
});

test('changed resource bytes still change the runtime bundle identity', () => {
  const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
  const original = bundle('UTC');
  const changed = bundle('UTC', { ...fixture, 'alpha.tex': fixture['alpha.tex'] + '% Edit\n' });
  assert.notEqual(hash(original), hash(changed));
});
