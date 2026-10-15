import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  clampChangePage,
  highlightForDisplayed,
  lateBeforeReadIsCurrent,
} from '../src/change-highlight-gate';

test('a late before-PDF read still applies after the agent run has cleared', () => {
  // PR #45 regression: the old guard compared against the active run, which
  // completion clears before a slow History read returns, so the highlight
  // never appeared. Only project/build identity decides now.
  assert.equal(lateBeforeReadIsCurrent({ id: 'p1', revision: 7 }, { id: 'p1', revision: 7 }), true);
});

test('a late before-PDF read is discarded after a project switch or newer edit', () => {
  const applied = { id: 'p1', revision: 7 };
  assert.equal(lateBeforeReadIsCurrent(applied, { id: 'p2', revision: 7 }), false);
  assert.equal(lateBeforeReadIsCurrent(applied, { id: 'p1', revision: 8 }), false);
});

test('highlights only draw over the PDF they were computed for', () => {
  const after = new Uint8Array([1, 2, 3]);
  const request = { runId: 'r1', before: new Uint8Array([0]), after };
  assert.equal(highlightForDisplayed(request, after), request);
  // Equal bytes in a different buffer are a different displayed document.
  assert.equal(highlightForDisplayed(request, new Uint8Array([1, 2, 3])), undefined);
  assert.equal(highlightForDisplayed(request, undefined), undefined);
  assert.equal(highlightForDisplayed(undefined, after), undefined);
});

test('change-stop navigation stays inside the displayed page range', () => {
  assert.equal(clampChangePage(5, 3), 3);
  assert.equal(clampChangePage(0, 3), 1);
  assert.equal(clampChangePage(2, 3), 2);
  assert.equal(clampChangePage(4, undefined), 4);
});
