import { test } from 'node:test';
import assert from 'node:assert/strict';
import { projectSwitchRetentionInputs } from '../scripts/verify-v8-retention-inputs.mjs';

const seed = () => ({
  passed: true,
  longSession: true,
  cycles: 120,
  errors: [],
  storage: [{ label: 'closed' }],
  appAsarSha256: 'a'.repeat(64),
});
const args = (overrides: Record<string, unknown> = {}) => ({
  diagnosticArg: '--retention-project-switch',
  cycles: 5,
  argvLength: 6,
  platform: 'darwin',
  arch: 'arm64',
  executableArg: '/Applications/Folio.app/Contents/MacOS/Folio',
  seedArg: 'test-results/process-profile-SEED',
  seed: seed(),
  appAsarSha256: 'a'.repeat(64),
  ...overrides,
});

test('non-matching diagnostic argument is ignored, returning null without checking any input', () => {
  assert.equal(
    projectSwitchRetentionInputs(args({ diagnosticArg: '--retention', seed: undefined })),
    null,
  );
  assert.equal(
    projectSwitchRetentionInputs(args({ diagnosticArg: undefined, seed: undefined })),
    null,
  );
});

test('accepted call returns an explicit unchanged-app identity record', () => {
  const result = projectSwitchRetentionInputs(args());
  assert.deepEqual(result, {
    mode: 'mounted-editor-project-switch',
    requiresUnchangedApp: true,
    appAsarSha256: 'a'.repeat(64),
    seedAppAsarSha256: 'a'.repeat(64),
    forcesGarbageCollection: false,
  });
});

test('rejects non-Apple-silicon hosts', () => {
  assert.throws(() => projectSwitchRetentionInputs(args({ platform: 'linux' })), /Apple silicon/);
  assert.throws(() => projectSwitchRetentionInputs(args({ arch: 'x64' })), /Apple silicon/);
});

test('rejects missing executable or seed directory arguments', () => {
  assert.throws(
    () => projectSwitchRetentionInputs(args({ executableArg: '' })),
    /Provide a packaged/,
  );
  assert.throws(() => projectSwitchRetentionInputs(args({ seedArg: '' })), /Provide a packaged/);
});

test('rejects unexpected extra arguments and out-of-range cycle counts', () => {
  assert.throws(() => projectSwitchRetentionInputs(args({ argvLength: 7 })), /extra arguments/);
  assert.throws(() => projectSwitchRetentionInputs(args({ cycles: 0 })), /1-20 cycles/);
  assert.throws(() => projectSwitchRetentionInputs(args({ cycles: 21 })), /1-20 cycles/);
  assert.throws(() => projectSwitchRetentionInputs(args({ cycles: 5.5 })), /1-20 cycles/);
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
      () => projectSwitchRetentionInputs(args({ seed: { ...seed(), ...overrides } })),
      /completed 120-cycle synthetic fixture/,
    );
  assert.throws(
    () => projectSwitchRetentionInputs(args({ seed: null })),
    /completed 120-cycle synthetic fixture/,
  );
});

test('requires the unchanged seed application, never a changed candidate', () => {
  assert.throws(
    () => projectSwitchRetentionInputs(args({ appAsarSha256: 'b'.repeat(64) })),
    /requires the unchanged seed application/,
  );
  assert.throws(
    () => projectSwitchRetentionInputs(args({ appAsarSha256: '' })),
    /Missing candidate application identity/,
  );
});
