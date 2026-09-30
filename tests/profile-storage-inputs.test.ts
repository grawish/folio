import { test } from 'node:test';
import assert from 'node:assert/strict';
import { profileStorageRunInputs } from '../scripts/profile-storage.mjs';
import { HISTORY_VERSIONS } from '../electron/core/workspace';

const args = (overrides: Record<string, unknown> = {}) => ({
  corpusDirectory: 'test-results/template-regression-SEED',
  rest: [] as string[],
  platform: 'darwin',
  arch: 'arm64',
  ...overrides,
});

test('default call (no extra argument) keeps the unchanged 1/25/100 three-sample small-fixture profile', () => {
  const result = profileStorageRunInputs(args());
  assert.deepEqual(result, {
    samples: 3,
    historyLengths: [1, 25, 100],
    maximumCount: false,
  });
});

test('a bare sample count still selects the unchanged 1/25/100 lengths', () => {
  assert.deepEqual(profileStorageRunInputs(args({ rest: ['1'] })), {
    samples: 1,
    historyLengths: [1, 25, 100],
    maximumCount: false,
  });
  assert.deepEqual(profileStorageRunInputs(args({ rest: ['5'] })), {
    samples: 5,
    historyLengths: [1, 25, 100],
    maximumCount: false,
  });
});

test('rejects out-of-range or non-integer sample counts', () => {
  assert.throws(() => profileStorageRunInputs(args({ rest: ['0'] })), /Usage:/);
  assert.throws(() => profileStorageRunInputs(args({ rest: ['6'] })), /Usage:/);
  assert.throws(() => profileStorageRunInputs(args({ rest: ['2.5'] })), /Usage:/);
});

test('--maximum-count opts into exactly one sample at the real HISTORY_VERSIONS boundary', () => {
  const result = profileStorageRunInputs(args({ rest: ['--maximum-count'] }));
  assert.deepEqual(result, {
    samples: 1,
    historyLengths: [HISTORY_VERSIONS],
    maximumCount: true,
  });
  assert.equal(HISTORY_VERSIONS, 1000);
});

test('rejects combining --maximum-count with a sample count or any other extra argument', () => {
  assert.throws(() => profileStorageRunInputs(args({ rest: ['3', '--maximum-count'] })), /Usage:/);
  assert.throws(() => profileStorageRunInputs(args({ rest: ['--bogus'] })), /Usage:/);
  assert.throws(
    () => profileStorageRunInputs(args({ rest: ['--maximum-count', '--maximum-count'] })),
    /Usage:/,
  );
});

test('rejects a missing corpus directory regardless of other arguments', () => {
  assert.throws(() => profileStorageRunInputs(args({ corpusDirectory: undefined })), /Usage:/);
  assert.throws(
    () => profileStorageRunInputs(args({ corpusDirectory: '', rest: ['--maximum-count'] })),
    /Usage:/,
  );
});

test('rejects non-Apple-silicon hosts even for an otherwise valid default call', () => {
  assert.throws(() => profileStorageRunInputs(args({ platform: 'linux' })), /Apple silicon/);
  assert.throws(() => profileStorageRunInputs(args({ arch: 'x64' })), /Apple silicon/);
});
