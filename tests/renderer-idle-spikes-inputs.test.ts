import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rendererIdleSpikeInputs } from '../scripts/verify-renderer-idle-spikes.mjs';

const seed = () => ({
  passed: true,
  longSession: true,
  cycles: 120,
  errors: [],
  storage: [{ label: 'closed' }],
  appAsarSha256: 'a'.repeat(64),
});
const args = (overrides: Record<string, unknown> = {}) => ({
  platform: 'darwin',
  arch: 'arm64',
  executableArg: '/Applications/Folio.app/Contents/MacOS/Folio',
  seedArg: 'test-results/process-profile-SEED',
  argvLength: 4,
  cycles: 120,
  seed: seed(),
  appAsarSha256: 'a'.repeat(64),
  ...overrides,
});

test('accepted call returns an explicit unchanged-app scan record', () => {
  const result = rendererIdleSpikeInputs(args());
  assert.deepEqual(result, {
    mode: 'renderer-idle-spike-scan',
    cycles: 120,
    appAsarSha256: 'a'.repeat(64),
    seedAppAsarSha256: 'a'.repeat(64),
    seedCycles: 120,
  });
});

test('rejects non-Apple-silicon hosts', () => {
  assert.throws(() => rendererIdleSpikeInputs(args({ platform: 'linux' })), /Apple silicon/);
  assert.throws(() => rendererIdleSpikeInputs(args({ arch: 'x64' })), /Apple silicon/);
});

test('rejects missing executable or seed directory arguments', () => {
  assert.throws(() => rendererIdleSpikeInputs(args({ executableArg: '' })), /Provide a packaged/);
  assert.throws(() => rendererIdleSpikeInputs(args({ seedArg: '' })), /Provide a packaged/);
});

test('rejects unexpected argument counts, never allowing extra flags that could change the idle dwell', () => {
  assert.throws(() => rendererIdleSpikeInputs(args({ argvLength: 3 })), /never changes/);
  assert.throws(() => rendererIdleSpikeInputs(args({ argvLength: 6 })), /never changes/);
});

test('rejects out-of-range cycle counts', () => {
  assert.throws(() => rendererIdleSpikeInputs(args({ cycles: 0 })), /1-360 cycles/);
  assert.throws(() => rendererIdleSpikeInputs(args({ cycles: 361 })), /1-360 cycles/);
  assert.throws(() => rendererIdleSpikeInputs(args({ cycles: 5.5 })), /1-360 cycles/);
});

test('fails closed on any deviation from the completed 120-cycle synthetic seed', () => {
  for (const overrides of [
    { passed: false },
    { longSession: false },
    { cycles: 5 },
    { errors: ['boom'] },
    { storage: [{ label: 'open' }] },
    { storage: [] },
  ])
    assert.throws(
      () => rendererIdleSpikeInputs(args({ seed: { ...seed(), ...overrides } })),
      /completed 120-cycle synthetic process-profile fixture/,
    );
  assert.throws(
    () => rendererIdleSpikeInputs(args({ seed: null })),
    /completed 120-cycle synthetic process-profile fixture/,
  );
});

test('rejects a seed report missing its own recorded application identity', () => {
  assert.throws(
    () => rendererIdleSpikeInputs(args({ seed: { ...seed(), appAsarSha256: undefined } })),
    /Seed report is missing/,
  );
});

test('requires the unchanged seed application, never a changed candidate', () => {
  assert.throws(
    () => rendererIdleSpikeInputs(args({ appAsarSha256: 'b'.repeat(64) })),
    /requires the exact unchanged seed application/,
  );
  assert.throws(
    () => rendererIdleSpikeInputs(args({ appAsarSha256: '' })),
    /Missing candidate application identity/,
  );
});
